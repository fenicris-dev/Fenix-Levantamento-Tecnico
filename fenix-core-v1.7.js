/**
 * ============================================================================
 * FÊNIX CORE v1.2
 * Módulo central de dados compartilhados entre todos os apps Fênix
 * ============================================================================
 *
 * O QUE É:
 * Este arquivo conecta seu app a um projeto Firebase SEPARADO ("fenix-core"),
 * dedicado exclusivamente a dados que são comuns entre todos os aplicativos:
 *   - Pessoas Físicas (CPF)
 *   - Pessoas Jurídicas (CNPJ)
 *   - Produtos / Serviços / Soluções
 *   - Cidades / UF / Bairros
 *
 * COMO USAR EM QUALQUER APP:
 * 1. Cole este arquivo <script> no seu HTML (ou importe como módulo).
 * 2. Preencha FENIX_CORE_CONFIG abaixo com as credenciais do projeto "fenix-core".
 * 3. Chame FenixCore.init() uma vez, no carregamento do app.
 * 4. Use as funções normalmente: FenixCore.pessoas.buscar(cpfOuCnpj), etc.
 *
 * IMPORTANTE:
 * Este módulo NÃO substitui o Firebase do seu app operacional (fenix-rat,
 * fenix-frotas, etc.). Ele roda EM PARALELO. Seu app continua com seu banco
 * próprio para dados específicos (boletins, veículos, aulas...) e usa o
 * fenix-core só para os dados de cadastro comuns.
 *
 * REGRA DE OURO:
 * Nenhum app deve mais ter sua própria coleção de "pessoas" ou "clientes"
 * completa. Ele guarda apenas a referência (CPF/CNPJ) + um cache leve opcional
 * (nome, cidade) pra exibição rápida em listas, sem duplicar o cadastro.
 *
 * HISTÓRICO DE VERSÕES:
 * v1.0 — Módulo base: Pessoas (PF/PJ), Produtos/Serviços, Localidades com
 *        aprendizado orgânico de bairro.
 * v1.1 — Adicionada localidades.buscarPorCEP() via ViaCEP: CEP passa a ser a
 *        fonte primária de logradouro/bairro/cidade/UF, com criação automática
 *        de cidade sob demanda. Bairro manual vira fallback, não regra.
 * v1.2 — Adicionada pessoas.buscarNaReceita() via BrasilAPI: CNPJ passa a ser
 *        consultado automaticamente na Receita Federal (razão social, nome
 *        fantasia, situação cadastral, endereço, CNAE).
 * ============================================================================
 */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, orderBy, limit as fsLimit,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ============================================================================
// 1. CONFIGURAÇÃO — credenciais do projeto Firebase "fenix-core"
// ============================================================================
// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDU8pGPVrBOS75Fry9FB3H5nokw6Qk5wpA",
  authDomain: "fenix-core-19e82.firebaseapp.com",
  projectId: "fenix-core-19e82",
  storageBucket: "fenix-core-19e82.firebasestorage.app",
  messagingSenderId: "296658490141",
  appId: "1:296658490141:web:cd2ac556069ded075307f4"
};

const CPF_CNPJ_DISCLOSURE = "O CPF/CNPJ é usado apenas para emissão de Notas Fiscais e/ou Recibos.";

let _db = null;
let _nomeAppChamador = "app-desconhecido"; // cada app deve se identificar no init()
const _NOME_APP_FIREBASE = "fenix-core-connection";

function _obterAppFirebase(config) {
  const existente = getApps().find(a => a.name === _NOME_APP_FIREBASE);
  if (existente) return existente;
  return initializeApp(config || firebaseConfig, _NOME_APP_FIREBASE);
}

/**
 * Inicializa a conexão com o fenix-core.
 * Chame uma vez só, no boot do app.
 * @param {string} nomeApp - identificador do app chamador, ex: "fenix-frotas", "fenix-financiamentos"
 */
function init(nomeApp) {
  _nomeAppChamador = nomeApp || _nomeAppChamador;
  const app = _obterAppFirebase(firebaseConfig);
  _db = getFirestore(app);
  return _db;
}

/**
 * Alternativa a init(): devolve {app, db} diretamente, sem depender do
 * estado interno _db. Usada por apps (como o Fênix Ativos) que também
 * precisam do objeto `app` pra montar Auth. Reaproveita a MESMA instância
 * do Firebase App que init() usaria, então os dois métodos são
 * intercambiáveis e nunca criam apps Firebase duplicados.
 * @param {object} config - opcional; usa firebaseConfig padrão se omitido
 */
function initFirebase(config) {
  const app = _obterAppFirebase(config);
  _db = getFirestore(app);
  return { app, db: _db };
}

function _garantirInit() {
  if (!_db) throw new Error("FenixCore não inicializado. Chame FenixCore.init('nome-do-seu-app') primeiro.");
}

// ============================================================================
// 2. HELPERS DE VALIDAÇÃO E FORMATAÇÃO (CPF / CNPJ)
// ============================================================================

function limparDocumento(valor) {
  return (valor || "").toString().replace(/\D/g, "");
}

function tipoDocumento(valor) {
  const limpo = limparDocumento(valor);
  if (limpo.length === 11) return "fisica";
  if (limpo.length === 14) return "juridica";
  return null;
}

function validarCPF(cpf) {
  cpf = limparDocumento(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let soma = 0, resto;
  for (let i = 1; i <= 9; i++) soma += parseInt(cpf.substring(i - 1, i)) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf.substring(9, 10))) return false;
  soma = 0;
  for (let i = 1; i <= 10; i++) soma += parseInt(cpf.substring(i - 1, i)) * (12 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(cpf.substring(10, 11));
}

function validarCNPJ(cnpj) {
  cnpj = limparDocumento(cnpj);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  let tamanho = cnpj.length - 2;
  let numeros = cnpj.substring(0, tamanho);
  const digitos = cnpj.substring(tamanho);
  let soma = 0, pos = tamanho - 7;
  for (let i = tamanho; i >= 1; i--) {
    soma += numeros.charAt(tamanho - i) * pos--;
    if (pos < 2) pos = 9;
  }
  let resultado = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  if (resultado !== parseInt(digitos.charAt(0))) return false;
  tamanho++;
  numeros = cnpj.substring(0, tamanho);
  soma = 0; pos = tamanho - 7;
  for (let i = tamanho; i >= 1; i--) {
    soma += numeros.charAt(tamanho - i) * pos--;
    if (pos < 2) pos = 9;
  }
  resultado = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  return resultado === parseInt(digitos.charAt(1));
}

function formatarCPF(cpf) {
  cpf = limparDocumento(cpf);
  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

function formatarCNPJ(cnpj) {
  cnpj = limparDocumento(cnpj);
  return cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
}

function formatarDocumento(valor) {
  const limpo = limparDocumento(valor);
  return limpo.length === 14 ? formatarCNPJ(limpo) : formatarCPF(limpo);
}

// ============================================================================
// 3. PESSOAS (Físicas e Jurídicas) — coleção unificada por tipo de documento
// ============================================================================

const pessoas = {

  /**
   * Busca uma pessoa (física ou jurídica) pelo CPF/CNPJ.
   * Detecta o tipo automaticamente pelo tamanho do documento.
   * @returns {object|null} dados da pessoa ou null se não encontrada
   */
  async buscar(cpfOuCnpj) {
    _garantirInit();
    const doc_id = limparDocumento(cpfOuCnpj);
    const tipo = tipoDocumento(doc_id);
    if (!tipo) throw new Error("CPF/CNPJ inválido: " + cpfOuCnpj);
    const colecao = tipo === "fisica" ? "pessoas_fisicas" : "pessoas_juridicas";
    const ref = doc(_db, colecao, doc_id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return { id: snap.id, tipo, ...snap.data() };
  },

  /**
   * Salva (cria ou atualiza) uma pessoa física.
   * @param {object} dados - { cpf, nome, telefone, email, endereco: {cep, logradouro, numero, complemento, bairro, cidade, uf} }
   */
  async salvarFisica(dados) {
    _garantirInit();
    const cpf = limparDocumento(dados.cpf);
    if (!validarCPF(cpf)) throw new Error("CPF inválido: " + dados.cpf);
    const ref = doc(_db, "pessoas_fisicas", cpf);
    const existente = await getDoc(ref);
    const payload = {
      ...dados,
      cpf,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: _nomeAppChamador,
      ...(existente.exists() ? {} : { criadoEm: serverTimestamp(), criadoPor: _nomeAppChamador })
    };
    await setDoc(ref, payload, { merge: true });
    return { id: cpf, tipo: "fisica", ...payload };
  },

  /**
   * Busca dados oficiais de um CNPJ na Receita Federal (via BrasilAPI, gratuita, sem chave).
   * Use isso ANTES de salvarJuridica, para pré-preencher o formulário automaticamente
   * assim que o usuário digitar o CNPJ — igual ao fluxo de CEP.
   *
   * Nota: API pública com uso razoável, sem SLA garantido. Para volume alto de
   * consultas no futuro, considerar alternativa paga (ReceitaWS, CNPJá).
   *
   * @returns {object|null} { cnpj, razaoSocial, nomeFantasia, situacaoCadastral,
   *   dataAbertura, cnaePrincipal, telefone, email,
   *   endereco: {cep, logradouro, numero, complemento, bairro, cidade, uf}, origem: 'receita' }
   */
  async buscarNaReceita(cnpj) {
    const cnpjLimpo = limparDocumento(cnpj);
    if (!validarCNPJ(cnpjLimpo)) throw new Error("CNPJ inválido: " + cnpj);

    const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjLimpo}`);
    if (!resp.ok) return null; // CNPJ não encontrado ou API indisponível
    const dados = await resp.json();

    return {
      cnpj: cnpjLimpo,
      razaoSocial: dados.razao_social || "",
      nomeFantasia: dados.nome_fantasia || "",
      situacaoCadastral: dados.descricao_situacao_cadastral || "",
      dataAbertura: dados.data_inicio_atividade || "",
      cnaePrincipal: dados.cnae_fiscal_descricao || "",
      telefone: dados.ddd_telefone_1 || "",
      email: dados.email || "",
      endereco: {
        cep: dados.cep || "",
        logradouro: `${dados.descricao_tipo_de_logradouro || ""} ${dados.logradouro || ""}`.trim(),
        numero: dados.numero || "",
        complemento: dados.complemento || "",
        bairro: dados.bairro || "",
        cidade: dados.municipio || "",
        uf: dados.uf || ""
      },
      origem: "receita"
    };
  },

  /**
   * Salva (cria ou atualiza) uma pessoa jurídica.
   * @param {object} dados - { cnpj, razaoSocial, nomeFantasia, telefone, email, endereco: {...} }
   */
  async salvarJuridica(dados) {
    _garantirInit();
    const cnpj = limparDocumento(dados.cnpj);
    if (!validarCNPJ(cnpj)) throw new Error("CNPJ inválido: " + dados.cnpj);
    const ref = doc(_db, "pessoas_juridicas", cnpj);
    const existente = await getDoc(ref);
    const payload = {
      ...dados,
      cnpj,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: _nomeAppChamador,
      ...(existente.exists() ? {} : { criadoEm: serverTimestamp(), criadoPor: _nomeAppChamador })
    };
    await setDoc(ref, payload, { merge: true });
    return { id: cnpj, tipo: "juridica", ...payload };
  },

  /**
   * Salva automaticamente detectando o tipo pelo tamanho do documento.
   */
  async salvar(dados) {
    const doc_id = limparDocumento(dados.cpf || dados.cnpj);
    const tipo = tipoDocumento(doc_id);
    if (tipo === "fisica") return pessoas.salvarFisica({ ...dados, cpf: doc_id });
    if (tipo === "juridica") return pessoas.salvarJuridica({ ...dados, cnpj: doc_id });
    throw new Error("Não foi possível determinar se é CPF ou CNPJ: " + doc_id);
  },

  /**
   * Busca por nome (client-side, prefixo). Útil para autocomplete.
   * Para bases grandes, considerar Algolia/Typesense futuramente.
   */
  async buscarPorNome(termo, tipo = "fisica", max = 10) {
    _garantirInit();
    const colecao = tipo === "fisica" ? "pessoas_fisicas" : "pessoas_juridicas";
    const campoNome = tipo === "fisica" ? "nome" : "razaoSocial";
    const termoUpper = termo.toUpperCase();
    const q = query(
      collection(_db, colecao),
      orderBy(campoNome),
      where(campoNome, ">=", termoUpper),
      where(campoNome, "<=", termoUpper + "\uf8ff"),
      fsLimit(max)
    );
    const snaps = await getDocs(q);
    return snaps.docs.map(d => ({ id: d.id, tipo, ...d.data() }));
  },

  disclosure: CPF_CNPJ_DISCLOSURE
};

// ============================================================================
// 4. PRODUTOS / SERVIÇOS / SOLUÇÕES — catálogo comum entre apps
// ============================================================================

const produtos = {

  /**
   * @param {object} dados - { nome, tipo: 'produto'|'servico'|'solucao', categoria, descricao, precoBase, unidade, ativo }
   * Se dados.id vier preenchido, atualiza; senão, cria novo com ID automático.
   */
  async salvar(dados) {
    _garantirInit();
    const id = dados.id || doc(collection(_db, "produtos_servicos")).id;
    const ref = doc(_db, "produtos_servicos", id);
    const existente = await getDoc(ref);
    const payload = {
      ...dados,
      id,
      ativo: dados.ativo !== undefined ? dados.ativo : true,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: _nomeAppChamador,
      ...(existente.exists() ? {} : { criadoEm: serverTimestamp(), criadoPor: _nomeAppChamador })
    };
    await setDoc(ref, payload, { merge: true });
    return payload;
  },

  async buscar(id) {
    _garantirInit();
    const snap = await getDoc(doc(_db, "produtos_servicos", id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  /**
   * Lista produtos/serviços, opcionalmente filtrando por tipo e só ativos.
   */
  async listar({ tipo = null, apenasAtivos = true } = {}) {
    _garantirInit();
    const clausulas = [];
    if (tipo) clausulas.push(where("tipo", "==", tipo));
    if (apenasAtivos) clausulas.push(where("ativo", "==", true));
    const q = query(collection(_db, "produtos_servicos"), ...clausulas);
    const snaps = await getDocs(q);
    return snaps.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async excluir(id) {
    _garantirInit();
    await deleteDoc(doc(_db, "produtos_servicos", id));
  }
};

// ============================================================================
// 5. LOCALIDADES — Cidades/UF (base fixa) + Bairros (aprendizado orgânico)
// ============================================================================

const localidades = {

  /**
   * Busca endereço completo a partir do CEP, usando ViaCEP (base oficial dos Correios).
   * Esta é a fonte PRIMÁRIA de bairro/cidade/UF — sempre prefira isso ao preenchimento manual.
   *
   * Também garante que a cidade exista em `cidades/{codigoIBGE}` (cria automaticamente
   * na primeira vez que aparece) e registra o bairro retornado, se houver.
   *
   * @returns {object|null} { cep, logradouro, bairro, cidade, uf, codigoIBGE, origem: 'cep' }
   *          bairro/logradouro podem vir vazios em cidades pequenas com CEP único —
   *          nesse caso, o app deve liberar o campo de bairro para digitação manual
   *          (use localidades.registrarBairro para gravar o valor digitado).
   */
  async buscarPorCEP(cep) {
    const cepLimpo = limparDocumento(cep);
    if (cepLimpo.length !== 8) throw new Error("CEP inválido: " + cep);

    const resp = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
    const dados = await resp.json();
    if (dados.erro) return null;

    const resultado = {
      cep: cepLimpo,
      logradouro: dados.logradouro || "",
      bairro: dados.bairro || "",
      cidade: dados.localidade || "",
      uf: dados.uf || "",
      codigoIBGE: dados.ibge || null,
      origem: "cep"
    };

    // Garante que a cidade exista na base local (criação automática sob demanda)
    if (resultado.codigoIBGE) {
      _garantirInit();
      const refCidade = doc(_db, "cidades", resultado.codigoIBGE);
      const existeCidade = await getDoc(refCidade);
      if (!existeCidade.exists()) {
        await setDoc(refCidade, {
          nome: resultado.cidade,
          uf: resultado.uf,
          criadoEm: serverTimestamp(),
          criadoPor: _nomeAppChamador,
          origem: "viacep"
        });
      }
      // Se o CEP já trouxe o bairro, registra como oficial (fonte CEP), sem precisar
      // esperar preenchimento manual do usuário.
      if (resultado.bairro) {
        await localidades.registrarBairro(resultado.codigoIBGE, resultado.bairro, "cep");
      }
    }

    return resultado;
  },

  /**
   * Busca cidades por UF (para popular <select>).
   * Populada automaticamente conforme os CEPs vão sendo consultados (buscarPorCEP),
   * sem necessidade de import antecipado.
   */
  async buscarCidadesPorUF(uf) {
    _garantirInit();
    const q = query(collection(_db, "cidades"), where("uf", "==", uf.toUpperCase()), orderBy("nome"));
    const snaps = await getDocs(q);
    return snaps.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  /**
   * Busca bairros já conhecidos de uma cidade (autocomplete).
   * @param {string} codigoIBGE - id do documento da cidade
   */
  async buscarBairros(codigoIBGE) {
    _garantirInit();
    const snaps = await getDocs(collection(_db, "cidades", codigoIBGE, "bairros"));
    return snaps.docs.map(d => d.id.replace(/-/g, " "));
  },

  /**
   * Registra um bairro novo para uma cidade, se ainda não existir.
   *
   * Chame isso em dois cenários:
   *  1) origem='cep' — automaticamente, dentro de buscarPorCEP (já acontece sozinho).
   *  2) origem='manual' — quando o usuário digita o bairro à mão, porque o CEP
   *     dele não retornou bairro (ex: cidade pequena com CEP único).
   *
   * Bairros com origem='cep' são confiáveis (base oficial dos Correios).
   * Bairros com origem='manual' são aprendizado orgânico — úteis para autocomplete,
   * mas não têm garantia de exatidão oficial.
   */
  async registrarBairro(codigoIBGE, nomeBairro, origem = "manual") {
    _garantirInit();
    if (!codigoIBGE || !nomeBairro) return;
    const slug = nomeBairro.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "-");
    const ref = doc(_db, "cidades", codigoIBGE, "bairros", slug);
    const existente = await getDoc(ref);
    if (!existente.exists()) {
      await setDoc(ref, {
        nomeOriginal: nomeBairro.trim(),
        origem, // 'cep' (oficial) ou 'manual' (aprendizado orgânico)
        criadoEm: serverTimestamp(),
        criadoPor: _nomeAppChamador
      });
    }
  }
};

// ============================================================================
// EXPORTAÇÃO
// ============================================================================

// ============================================================================
// 6. AUTENTICAÇÃO (e-mail/senha) — usada por apps multiempresa como o Fênix Ativos
// ============================================================================
/**
 * @param {object} app - o objeto `app` retornado por initFirebase()
 */
function criarModuloAuth(app) {
  const auth = getAuth(app);
  return {
    aoMudarEstado(callback) {
      return onAuthStateChanged(auth, callback);
    },
    entrar(email, senha) {
      return signInWithEmailAndPassword(auth, email, senha).then(cred => cred.user);
    },
    criarConta(email, senha) {
      return createUserWithEmailAndPassword(auth, email, senha).then(cred => cred.user);
    },
    sair() {
      return signOut(auth);
    },
    usuarioAtual() {
      return auth.currentUser;
    }
  };
}

// ============================================================================
// 7. EMPRESAS — cadastro multiempresa e vínculo usuário↔empresa
// ============================================================================
/**
 * Estrutura no Firestore:
 *   empresas/{empresaId}                -> {nome, donoUid, donoEmail, criadoEm}
 *   empresas/{empresaId}/membros/{uid}  -> {email, papel, status, criadoEm}
 *   usuariosEmpresa/{uid}                -> {empresaId, papel, status}  (índice rápido pra achar a empresa de um usuário)
 * @param {object} db - o objeto `db` retornado por initFirebase()
 */
function criarModuloEmpresas(db) {
  return {
    criarEmpresa(uid, email, nome) {
      const ref = doc(collection(db, "empresas"));
      const empresa = { nome, donoUid: uid, donoEmail: email, criadoEm: serverTimestamp() };
      return setDoc(ref, empresa).then(() =>
        setDoc(doc(db, "empresas", ref.id, "membros", uid), { email, papel: "dono", status: "aprovado", criadoEm: serverTimestamp() })
      ).then(() =>
        setDoc(doc(db, "usuariosEmpresa", uid), { empresaId: ref.id, papel: "dono", status: "aprovado" })
      ).then(() => ({ id: ref.id, nome }));
    },
    obterEmpresa(empresaId) {
      return getDoc(doc(db, "empresas", empresaId)).then(snap => snap.exists() ? { id: snap.id, ...snap.data() } : null);
    },
    obterEmpresaDoUsuario(uid) {
      return getDoc(doc(db, "usuariosEmpresa", uid)).then(snap => snap.exists() ? snap.data() : null);
    },
    repararVinculo(uid, dadosParciais) {
      return updateDoc(doc(db, "usuariosEmpresa", uid), dadosParciais);
    }
  };
}

// ============================================================================
// 8. CONVITES — convidar técnicos/membros pra uma empresa por link/token
// ============================================================================
/**
 * @param {object} db
 * @param {string} baseUrl - URL base do app (sem query string) usada pra montar o link do convite
 */
function criarModuloConvites(db, baseUrl) {
  function gerarToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return {
    criarConvite(empresaId, criadorUid, criadorEmail, destinatario) {
      const token = gerarToken();
      const convite = {
        empresaId, criadoPorUid: criadorUid, criadoPor: criadorEmail,
        destinatario: destinatario || null, usado: false, cancelado: false, criadoEm: serverTimestamp()
      };
      return setDoc(doc(db, "convites", token), convite).then(() => ({ token, link: baseUrl + "?convite=" + token }));
    },
    obterConvite(token) {
      return getDoc(doc(db, "convites", token)).then(snap => snap.exists() ? { token, ...snap.data() } : null);
    },
    aceitarConvite(token, uid, email) {
      const refConvite = doc(db, "convites", token);
      return getDoc(refConvite).then(snap => {
        if (!snap.exists()) throw new Error("Convite não encontrado.");
        const convite = snap.data();
        if (convite.usado) throw new Error("Este convite já foi utilizado.");
        return setDoc(doc(db, "empresas", convite.empresaId, "membros", uid), { email, papel: "tecnico", status: "aprovado", criadoEm: serverTimestamp() })
          .then(() => setDoc(doc(db, "usuariosEmpresa", uid), { empresaId: convite.empresaId, papel: "tecnico", status: "aprovado" }))
          .then(() => updateDoc(refConvite, { usado: true, usadoPorUid: uid, usadoEm: serverTimestamp() }))
          .then(() => getDoc(doc(db, "empresas", convite.empresaId)))
          .then(empSnap => ({ id: empSnap.id, ...empSnap.data() }));
      });
    },
    listarConvitesPendentes(empresaId) {
      return getDocs(query(collection(db, "convites"), where("empresaId", "==", empresaId), where("usado", "==", false)))
        .then(snap => snap.docs.filter(d => !d.data().cancelado).map(d => ({ token: d.id, ...d.data() })));
    },
    cancelarConvite(token) {
      return updateDoc(doc(db, "convites", token), { cancelado: true });
    }
  };
}

// ============================================================================
// 9. EQUIPE — membros de uma empresa
// ============================================================================
function criarModuloEquipe(db) {
  return {
    listarMembros(empresaId) {
      return getDocs(collection(db, "empresas", empresaId, "membros"))
        .then(snap => snap.docs.map(d => ({ uid: d.id, ...d.data() })));
    },
    removerMembro(empresaId, uidAlvo) {
      return deleteDoc(doc(db, "empresas", empresaId, "membros", uidAlvo))
        .then(() => deleteDoc(doc(db, "usuariosEmpresa", uidAlvo)).catch(() => {}));
    }
  };
}

// ============================================================================
// 10. APPDATA — mirror genérico de "tabelas" locais de um app, por empresa
// ============================================================================
/**
 * Guarda arrays inteiros (localStorage-like) na nuvem, um documento por
 * chave. Usado pelo Fênix Ativos pra sincronizar solucoes/ativos/kits/etc.
 * sem precisar de um schema próprio no fenix-core pra cada app.
 * @param {object} db
 * @param {string} empresaId
 * @param {string} nomeApp - namespace do app chamador (evita colisão entre apps na mesma empresa)
 */
function criarModuloAppData(db, empresaId, nomeApp) {
  return {
    salvar(chave, arr) {
      return setDoc(doc(db, "empresas", empresaId, "appData", nomeApp + "_" + chave), {
        dados: arr, atualizadoEm: serverTimestamp()
      }).then(() => true).catch(() => false);
    },
    carregar(chave) {
      return getDoc(doc(db, "empresas", empresaId, "appData", nomeApp + "_" + chave))
        .then(snap => snap.exists() ? (snap.data().dados || []) : null);
    }
  };
}

// ============================================================================
// 11. CATÁLOGOS POR EMPRESA — materiais, produtos/serviços, famílias de material
// ============================================================================
/** Helper genérico: coleção de catálogo dentro de uma empresa, "salvar" faz upsert pela chave informada. */
function _criarModuloCatalogoEmpresa(db, empresaId, nomeColecao, campoChave) {
  return {
    listar() {
      return getDocs(collection(db, "empresas", empresaId, nomeColecao))
        .then(snap => snap.docs.map(d => ({ id: d.id, ...d.data() })));
    },
    salvar(obj) {
      const chave = obj[campoChave] || obj.id;
      if (!chave) return Promise.reject(new Error(nomeColecao + ": faltou o campo '" + campoChave + "' pra identificar o registro."));
      return setDoc(doc(db, "empresas", empresaId, nomeColecao, String(chave)), {
        ...obj, atualizadoEm: serverTimestamp()
      }, { merge: true }).then(() => true);
    }
  };
}
function criarModuloMateriais(db, empresaId) {
  return _criarModuloCatalogoEmpresa(db, empresaId, "materiais", "codigoFabricante");
}
function criarModuloProdutosServicos(db, empresaId) {
  return _criarModuloCatalogoEmpresa(db, empresaId, "produtos_servicos", "id");
}
function criarModuloFamiliasMateriais(db, empresaId) {
  return _criarModuloCatalogoEmpresa(db, empresaId, "familias_materiais", "id");
}

// ============================================================================
// 12. PESSOAS POR EMPRESA — clientes de um app específico (distinto do
//     cadastro nacional de CPF/CNPJ compartilhado em `pessoas`, acima)
// ============================================================================
function criarModuloPessoas(db, empresaId) {
  return {
    listar() {
      return getDocs(collection(db, "empresas", empresaId, "pessoas"))
        .then(snap => snap.docs.map(d => ({ id: d.id, ...d.data() })));
    },
    salvar(obj) {
      if (!obj.id) return Promise.reject(new Error("pessoas: registro sem id."));
      return setDoc(doc(db, "empresas", empresaId, "pessoas", obj.id), {
        ...obj, atualizadoEm: serverTimestamp()
      }, { merge: true }).then(() => true);
    },
    arquivar(obj, arquivado) {
      if (!obj.id) return Promise.reject(new Error("pessoas: registro sem id."));
      return updateDoc(doc(db, "empresas", empresaId, "pessoas", obj.id), { arquivado: !!arquivado });
    },
    excluir(obj) {
      if (!obj.id) return Promise.reject(new Error("pessoas: registro sem id."));
      return deleteDoc(doc(db, "empresas", empresaId, "pessoas", obj.id));
    }
  };
}

export const FenixCore = {
  init,
  initFirebase,
  criarModuloAuth,
  criarModuloEmpresas,
  criarModuloConvites,
  criarModuloEquipe,
  criarModuloAppData,
  criarModuloMateriais,
  criarModuloProdutosServicos,
  criarModuloFamiliasMateriais,
  criarModuloPessoas,
  pessoas,
  produtos,
  localidades,
  validarCPF,
  validarCNPJ,
  formatarCPF,
  formatarCNPJ,
  formatarDocumento,
  limparDocumento,
  tipoDocumento,
  CPF_CNPJ_DISCLOSURE
};

/**
 * ============================================================================
 * EXEMPLO DE USO EM UM APP (ex: Fênix Financiamentos)
 * ============================================================================
 *
 * import { FenixCore } from "./fenix-core-v1.0.js";
 *
 * FenixCore.init("fenix-financiamentos");
 *
 * // Ao digitar o CPF do cliente no formulário:
 * const cpfDigitado = "12345678900";
 * const pessoa = await FenixCore.pessoas.buscar(cpfDigitado);
 *
 * if (pessoa) {
 *   // preenche o formulário automaticamente
 *   document.getElementById("nome").value = pessoa.nome;
 *   document.getElementById("endereco").value = pessoa.endereco?.logradouro || "";
 * } else {
 *   // mostra formulário de cadastro novo
 *
 *   // 1) Ao digitar o CEP, busca endereço oficial (Correios via ViaCEP):
 *   const endereco = await FenixCore.localidades.buscarPorCEP("49000-000");
 *   if (endereco) {
 *     document.getElementById("logradouro").value = endereco.logradouro;
 *     document.getElementById("cidade").value = endereco.cidade;
 *     document.getElementById("uf").value = endereco.uf;
 *     if (endereco.bairro) {
 *       // CEP trouxe o bairro (caso comum) — já preenche e já está registrado
 *       document.getElementById("bairro").value = endereco.bairro;
 *     } else {
 *       // CEP genérico de cidade pequena, sem bairro — libera campo manual
 *       document.getElementById("bairro").disabled = false;
 *       // ao usuário digitar e sair do campo:
 *       // await FenixCore.localidades.registrarBairro(endereco.codigoIBGE, valorDigitado, "manual");
 *     }
 *   }
 *
 *   // 2) Ao salvar o cadastro:
 *   await FenixCore.pessoas.salvarFisica({
 *     cpf: cpfDigitado,
 *     nome: "João da Silva",
 *     telefone: "(79) 99999-0000",
 *     email: "joao@email.com",
 *     endereco: {
 *       cep: "49000-000", logradouro: "Rua Y", numero: "123",
 *       bairro: "Centro", cidade: "Aracaju", uf: "SE"
 *     }
 *   });
 * }
 *
 * // Mesma lógica serve para CNPJ, buscando na Receita Federal:
 * const dadosReceita = await FenixCore.pessoas.buscarNaReceita("12345678000199");
 * if (dadosReceita) {
 *   document.getElementById("razaoSocial").value = dadosReceita.razaoSocial;
 *   document.getElementById("cidade").value = dadosReceita.endereco.cidade;
 *   // etc. — depois, ao salvar, chama FenixCore.pessoas.salvarJuridica(dadosReceita)
 * }
 *
 * // No app operacional (banco próprio do Financiamentos), grava só a referência:
 * // { cpfCliente: "12345678900", valorFinanciado: 15000, ... }
 * // Nunca duplica nome/endereço lá — sempre busca no FenixCore quando precisar exibir.
 * ============================================================================
 */
