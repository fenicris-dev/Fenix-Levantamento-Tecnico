/**
 * ============================================================================
 * FÊNIX CORE v1.3
 * Módulo central de dados compartilhados entre todos os apps Fênix
 * ============================================================================
 *
 * O QUE É:
 * Este arquivo conecta seu app a um projeto Firebase SEPARADO ("fenix-core"),
 * dedicado exclusivamente a dados que são comuns entre todos os aplicativos:
 *   - Pessoas Físicas (CPF)
 *   - Pessoas Jurídicas (CNPJ)
 *   - Produtos / Serviços / Soluções
 *   - Materiais (itens físicos revendidos, catálogo de fabricante)
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
 * v1.3 — Adicionado FenixCore.materiais: catálogo de itens físicos revendidos
 *        (código de fabricante, família, tipo, preço de compra/venda), com
 *        suporte a importação periódica em massa via planilha (upsert +
 *        inativação automática de itens que saíram do portfólio). Adicionado
 *        FenixCore.familias (lista controlada de famílias de material).
 * ============================================================================
 */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, orderBy, limit as fsLimit,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ============================================================================
// 1. CONFIGURAÇÃO — preencha com as credenciais do projeto Firebase "fenix-core"
// ============================================================================
const FENIX_CORE_CONFIG = {
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

/**
 * Inicializa a conexão com o fenix-core.
 * Chame uma vez só, no boot do app.
 * @param {string} nomeApp - identificador do app chamador, ex: "fenix-frotas", "fenix-financiamentos"
 */
function init(nomeApp) {
  _nomeAppChamador = nomeApp || _nomeAppChamador;
  const appName = "fenix-core-connection";
  const app = getApps().find(a => a.name === appName) || initializeApp(FENIX_CORE_CONFIG, appName);
  _db = getFirestore(app);
  return _db;
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
// 5. FAMÍLIAS DE MATERIAL — lista controlada (Segurança Eletrônica, Energia...)
// ============================================================================
// Diferente de bairro, aqui NÃO deixamos crescer sozinho: são poucas famílias,
// cadastradas manualmente uma vez, e usadas como categoria fixa nos materiais.

const familias = {

  /**
   * @param {object} dados - { id (opcional), nome, ativo }
   * Se dados.id vier preenchido, atualiza; senão, cria com ID slug do nome.
   */
  async salvar(dados) {
    _garantirInit();
    const id = dados.id || dados.nome.trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "-");
    const ref = doc(_db, "familias_materiais", id);
    const payload = {
      nome: dados.nome,
      ativo: dados.ativo !== undefined ? dados.ativo : true,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: _nomeAppChamador
    };
    await setDoc(ref, payload, { merge: true });
    return { id, ...payload };
  },

  async listar({ apenasAtivas = true } = {}) {
    _garantirInit();
    const clausulas = apenasAtivas ? [where("ativo", "==", true)] : [];
    const q = query(collection(_db, "familias_materiais"), ...clausulas, orderBy("nome"));
    const snaps = await getDocs(q);
    return snaps.docs.map(d => ({ id: d.id, ...d.data() }));
  }
};

// ============================================================================
// 6. MATERIAIS — catálogo de itens físicos revendidos (fabricante, preços)
// ============================================================================
// Chave natural: código do fabricante (evita duplicidade, igual CPF/CNPJ).
// Alimentado por cadastro manual OU por importação periódica em massa
// (ver materiais.importarPlanilha).

const materiais = {

  /**
   * Cria ou atualiza um material.
   * @param {object} dados - { codigoFabricante, descricao, familia, tipoProduto,
   *   precoCompra, precoVenda, ativo }
   */
  async salvar(dados) {
    _garantirInit();
    const codigo = (dados.codigoFabricante || "").trim();
    if (!codigo) throw new Error("codigoFabricante é obrigatório.");
    const ref = doc(_db, "materiais", codigo);
    const existente = await getDoc(ref);
    const payload = {
      ...dados,
      codigoFabricante: codigo,
      ativo: dados.ativo !== undefined ? dados.ativo : true,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: _nomeAppChamador,
      ...(existente.exists() ? {} : { criadoEm: serverTimestamp(), criadoPor: _nomeAppChamador })
    };
    await setDoc(ref, payload, { merge: true });
    return payload;
  },

  async buscarPorCodigo(codigoFabricante) {
    _garantirInit();
    const snap = await getDoc(doc(_db, "materiais", codigoFabricante.trim()));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  /**
   * Lista materiais, com filtros opcionais.
   * @param {object} filtros - { familia, tipoProduto, apenasAtivos = true }
   */
  async listar({ familia = null, tipoProduto = null, apenasAtivos = true } = {}) {
    _garantirInit();
    const clausulas = [];
    if (familia) clausulas.push(where("familia", "==", familia));
    if (tipoProduto) clausulas.push(where("tipoProduto", "==", tipoProduto));
    if (apenasAtivos) clausulas.push(where("ativo", "==", true));
    const q = query(collection(_db, "materiais"), ...clausulas);
    const snaps = await getDocs(q);
    return snaps.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  /**
   * Importação periódica em massa a partir de uma planilha já convertida em array
   * de objetos (ex: via SheetJS/XLSX.utils.sheet_to_json no app de import).
   *
   * Comportamento:
   *  - Cada linha faz upsert em materiais/{codigoFabricante} (atualiza preço,
   *    família, descrição, tipo).
   *  - Qualquer material que JÁ EXISTIA no banco mas NÃO apareceu nesta
   *    importação é marcado ativo=false automaticamente (saiu do portfólio).
   *  - Nunca exclui documentos — histórico de RATs/orçamentos antigos que
   *    referenciam o código continua íntegro.
   *
   * @param {Array<object>} linhas - cada linha: { codigoFabricante, descricao,
   *   familia, tipoProduto, precoCompra, precoVenda }
   * @param {string} nomeArquivoOrigem - ex: "planilha-agosto-2026.xlsx", só para auditoria
   * @returns {object} resumo: { criados, atualizados, inativados }
   */
  async importarPlanilha(linhas, nomeArquivoOrigem = "") {
    _garantirInit();
    const codigosNaPlanilha = new Set();
    let criados = 0, atualizados = 0, inativados = 0;

    // 1) Upsert de cada linha da planilha
    for (const linha of linhas) {
      const codigo = (linha.codigoFabricante || "").toString().trim();
      if (!codigo) continue;
      codigosNaPlanilha.add(codigo);

      const ref = doc(_db, "materiais", codigo);
      const existente = await getDoc(ref);
      const payload = {
        codigoFabricante: codigo,
        descricao: linha.descricao || "",
        familia: linha.familia || "",
        tipoProduto: linha.tipoProduto || "",
        precoCompra: Number(linha.precoCompra) || 0,
        precoVenda: Number(linha.precoVenda) || 0,
        ativo: true,
        ultimaImportacao: serverTimestamp(),
        origemImportacao: nomeArquivoOrigem,
        atualizadoEm: serverTimestamp(),
        atualizadoPor: _nomeAppChamador,
        ...(existente.exists() ? {} : { criadoEm: serverTimestamp(), criadoPor: _nomeAppChamador })
      };
      await setDoc(ref, payload, { merge: true });
      existente.exists() ? atualizados++ : criados++;
    }

    // 2) Inativa quem existia no banco mas não veio nesta planilha
    const todosSnap = await getDocs(collection(_db, "materiais"));
    for (const d of todosSnap.docs) {
      if (!codigosNaPlanilha.has(d.id) && d.data().ativo) {
        await updateDoc(doc(_db, "materiais", d.id), {
          ativo: false,
          atualizadoEm: serverTimestamp(),
          atualizadoPor: _nomeAppChamador,
          motivoInativacao: "Não encontrado na importação: " + nomeArquivoOrigem
        });
        inativados++;
      }
    }

    return { criados, atualizados, inativados, total: linhas.length };
  }
};

// ============================================================================
// 7. LOCALIDADES — Cidades/UF (base fixa) + Bairros (aprendizado orgânico)
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

export const FenixCore = {
  init,
  pessoas,
  produtos,
  materiais,
  familias,
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
 *
 * // ------------------------------------------------------------------------
 * // MATERIAIS — cadastro de itens revendidos, consumido pelos 4 apps que usam
 * // ------------------------------------------------------------------------
 *
 * // Consulta simples em qualquer app (ex: montar um orçamento):
 * const item = await FenixCore.materiais.buscarPorCodigo("NVR-8CH-4K");
 *
 * // Listar por família/tipo (ex: preencher um <select> de "Segurança Eletrônica"):
 * const nvrs = await FenixCore.materiais.listar({ familia: "Segurança Eletrônica", tipoProduto: "NVR" });
 *
 * // No app de importação periódica (o único que faz upload de planilha):
 * // 1) Lê o arquivo com SheetJS: const linhas = XLSX.utils.sheet_to_json(planilha);
 * // 2) Cada linha deve ter: codigoFabricante, descricao, familia, tipoProduto, precoCompra, precoVenda
 * const resumo = await FenixCore.materiais.importarPlanilha(linhas, "planilha-agosto-2026.xlsx");
 * console.log(resumo); // { criados: 3, atualizados: 128, inativados: 5, total: 131 }
 * // Os 5 inativados eram itens que saíram do portfólio (não vieram nesta planilha) —
 * // eles continuam no banco (ativo=false), preservando histórico de RATs/orçamentos antigos.
 * ============================================================================
 */
