// ============================================================
// Fênix Core v1.6
// Módulo compartilhado entre os apps Fênix.
//
// Mudança da v1.5 pra v1.6: CONVITE, não código fixo.
// Antes, qualquer pessoa que soubesse o código de 6 caracteres da
// empresa entrava sozinha, sem o dono aprovar nada. Agora funciona
// como o compartilhamento de casa inteligente (Intelbras/Hikvision):
// o titular gera um convite de uso único (link, com opção de QR
// Code, WhatsApp ou e-mail); a pessoa convidada se cadastra, confirma
// que quer participar, e só assim fica vinculada — o próprio convite
// já é a autorização do titular, não precisa de aprovação em duas
// etapas.
//
// Fluxo esperado em qualquer app Fênix, depois do login:
//
//   var Empresas = FenixCore.criarModuloEmpresas(db);
//   var Convites = FenixCore.criarModuloConvites(db);
//   var uid = Auth.usuarioAtual().uid;
//
//   Empresas.obterEmpresaDoUsuario(uid).then(function(vinculo){
//     if(vinculo){ /* já pertence a uma empresa — use vinculo.empresaId */ }
//     else { /* primeiro acesso: criar empresa OU aceitar convite */ }
//   });
//
//   // Dono convida alguém:
//   Convites.criarConvite(empresaId, uid, email, 'Nome de quem recebe (opcional)')
//     .then(function(convite){ /* convite.token, convite.link */ });
//
//   // Pessoa convidada (depois de logar), com o token da URL:
//   Convites.obterConvite(token).then(function(convite){ /* mostrar nome da empresa, confirmar */ });
//   Convites.aceitarConvite(token, uid, email).then(function(empresa){ /* pronto, já entrou */ });
//
//   // Depois de saber o empresaId, os módulos de dados exigem esse id:
//   var Pessoas = FenixCore.criarModuloPessoas(db, empresaId);
//   ...
// ============================================================

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs, deleteDoc, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- Firebase: inicialização única e compartilhada ----------
function initFirebase(firebaseConfig){
  var app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  var db = getFirestore(app);
  return { app: app, db: db };
}

function novoId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function apenasDigitos(v){
  return String(v || '').replace(/\D/g, '');
}
function slugify(str){
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '') || novoId();
}
function gerarCodigoEmpresa(){
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var codigo = '';
  for(var i=0;i<6;i++){ codigo += chars.charAt(Math.floor(Math.random()*chars.length)); }
  return codigo;
}
// Token de convite: mais longo que o código de empresa — não precisa
// ser digitado de cabeça, só clicado ou colado a partir do link.
function gerarTokenConvite(){
  var chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  var token = '';
  for(var i=0;i<12;i++){ token += chars.charAt(Math.floor(Math.random()*chars.length)); }
  return token;
}

// Lista curta de domínios de e-mail temporário/descartável mais comuns.
// Não é exaustiva de propósito — é uma primeira barreira, não a única.
var DOMINIOS_EMAIL_TEMPORARIO = [
  'mailinator.com','guerrillamail.com','10minutemail.com','yopmail.com',
  'tempmail.com','temp-mail.org','throwawaymail.com','trashmail.com',
  'getnada.com','sharklasers.com','dispostable.com','fakeinbox.com',
  'maildrop.cc','mintemail.com','mohmal.com','moakt.com','emailondeck.com'
];
function ehEmailTemporario(email){
  var dominio = String(email||'').split('@')[1];
  if(!dominio) return false;
  dominio = dominio.trim().toLowerCase();
  return DOMINIOS_EMAIL_TEMPORARIO.indexOf(dominio) !== -1;
}

// ---------- Autenticação (e-mail/senha) ----------
function criarModuloAuth(app){
  var auth = getAuth(app);
  function entrar(email, senha){ return signInWithEmailAndPassword(auth, email, senha); }
  function criarConta(email, senha){
    if(ehEmailTemporario(email)) return Promise.reject(new Error('E-mails temporários/descartáveis não são aceitos. Use um e-mail de verdade.'));
    return createUserWithEmailAndPassword(auth, email, senha);
  }
  function sair(){ return signOut(auth); }
  function aoMudarEstado(cb){ return onAuthStateChanged(auth, cb); }
  function usuarioAtual(){ return auth.currentUser; }
  return {
    entrar: entrar, criarConta: criarConta, sair: sair,
    aoMudarEstado: aoMudarEstado, usuarioAtual: usuarioAtual,
    ehEmailTemporario: ehEmailTemporario
  };
}

// ---------- Empresas (multi-tenant) ----------
function criarModuloEmpresas(db){
  function obterEmpresaDoUsuario(uid){
    return getDoc(doc(db, 'usuarios_empresa', uid)).then(function(snap){
      return snap.exists() ? snap.data() : null;
    });
  }
  function obterEmpresa(empresaId){
    return getDoc(doc(db, 'empresas', empresaId)).then(function(snap){
      return snap.exists() ? snap.data() : null;
    });
  }
  // Quem cria a empresa vira o titular (dono) — já entra aprovado.
  function criarEmpresa(uid, email, nome){
    var empresaId = gerarCodigoEmpresa();
    var dadosEmpresa = { id: empresaId, nome: nome, criadoEm: new Date().toISOString(), criadoPor: email };
    return setDoc(doc(db, 'empresas', empresaId), dadosEmpresa).then(function(){
      return setDoc(doc(db, 'usuarios_empresa', uid), {
        empresaId: empresaId, email: email, papel: 'dono', status: 'aprovado', entrouEm: new Date().toISOString()
      });
    }).then(function(){ return dadosEmpresa; });
  }
  return {
    obterEmpresaDoUsuario: obterEmpresaDoUsuario,
    obterEmpresa: obterEmpresa,
    criarEmpresa: criarEmpresa
  };
}

// ---------- Convites (padrão "casa inteligente": link único, QR, WhatsApp, e-mail) ----------
function criarModuloConvites(db, urlBaseApp){
  // urlBaseApp: URL completa do app (ex.: location.href sem query string),
  // usada só pra montar o link do convite — cada app Fênix passa a sua.
  function linkDoConvite(token){
    var base = urlBaseApp || (typeof location !== 'undefined' ? location.origin + location.pathname : '');
    return base + '?convite=' + token;
  }

  // O titular gera o convite. 'destinatario' é só um rótulo livre
  // (nome/telefone/e-mail de quem vai receber), pra ele lembrar depois
  // quem é quem na lista de convites pendentes — não trava nada.
  function criarConvite(empresaId, uidCriador, emailCriador, destinatario){
    var token = gerarTokenConvite();
    var dados = {
      token: token, empresaId: empresaId,
      criadoPor: emailCriador, criadoPorUid: uidCriador,
      destinatario: destinatario || '', usado: false,
      criadoEm: new Date().toISOString()
    };
    return setDoc(doc(db, 'convites', token), dados).then(function(){
      dados.link = linkDoConvite(token);
      return dados;
    });
  }

  function obterConvite(token){
    return getDoc(doc(db, 'convites', token)).then(function(snap){
      return snap.exists() ? snap.data() : null;
    });
  }

  // A pessoa convidada, já logada, aceita — vincula direto (aprovado),
  // porque o convite em si já foi a autorização do titular.
  function aceitarConvite(token, uid, email){
    return getDoc(doc(db, 'convites', token)).then(function(snap){
      if(!snap.exists()) throw new Error('Convite não encontrado ou já expirado.');
      var convite = snap.data();
      if(convite.usado) throw new Error('Este convite já foi utilizado.');
      return setDoc(doc(db, 'usuarios_empresa', uid), {
        empresaId: convite.empresaId, email: email, papel: 'tecnico', status: 'aprovado', entrouEm: new Date().toISOString()
      }).then(function(){
        return setDoc(doc(db, 'convites', token), { usado: true, usadoPor: email, usadoEm: new Date().toISOString() }, { merge: true });
      }).then(function(){
        return getDoc(doc(db, 'empresas', convite.empresaId));
      }).then(function(empresaSnap){
        return empresaSnap.exists() ? empresaSnap.data() : { id: convite.empresaId };
      });
    });
  }

  function listarConvitesPendentes(empresaId){
    var q = query(collection(db, 'convites'), where('empresaId', '==', empresaId));
    return getDocs(q).then(function(snap){
      var out = [];
      snap.forEach(function(d){ var c = d.data(); if(!c.usado) out.push(c); });
      return out;
    });
  }

  function cancelarConvite(token){
    return deleteDoc(doc(db, 'convites', token));
  }

  return {
    criarConvite: criarConvite,
    obterConvite: obterConvite,
    aceitarConvite: aceitarConvite,
    listarConvitesPendentes: listarConvitesPendentes,
    cancelarConvite: cancelarConvite,
    linkDoConvite: linkDoConvite
  };
}

// ---------- Gestão de equipe (papel, remover) ----------
function criarModuloEquipe(db){
  function listarMembros(empresaId){
    var q = query(collection(db, 'usuarios_empresa'), where('empresaId', '==', empresaId));
    return getDocs(q).then(function(snap){
      var out = [];
      snap.forEach(function(d){ out.push(Object.assign({ uid: d.id }, d.data())); });
      return out;
    });
  }
  function removerMembro(uid){
    return deleteDoc(doc(db, 'usuarios_empresa', uid));
  }
  return { listarMembros: listarMembros, removerMembro: removerMembro };
}

// ---------- Cadastro de Pessoas (PF/PJ) — isolado por empresa ----------
function criarModuloPessoas(db, empresaId){
  function colecaoDoTipo(tipoPessoa){
    return 'empresas/' + empresaId + '/' + (tipoPessoa === 'PJ' ? 'pessoas_juridicas' : 'pessoas_fisicas');
  }
  function chaveDaPessoa(pessoa){
    return apenasDigitos(pessoa.tipoPessoa === 'PJ' ? pessoa.cnpj : pessoa.cpf);
  }
  function salvar(pessoa){
    var chave = chaveDaPessoa(pessoa);
    if(!chave) return Promise.reject(new Error('Pessoa sem CPF/CNPJ válido — não é possível sincronizar com o Fênix Core.'));
    var agora = new Date().toISOString();
    var dados = Object.assign({}, pessoa, { atualizadoEm: agora });
    if(!dados.criadoEm) dados.criadoEm = agora;
    return setDoc(doc(db, colecaoDoTipo(pessoa.tipoPessoa), chave), dados).then(function(){ return dados; });
  }
  function buscar(tipoPessoa, documento){
    var chave = apenasDigitos(documento);
    if(!chave) return Promise.resolve(null);
    return getDoc(doc(db, colecaoDoTipo(tipoPessoa), chave)).then(function(snap){
      return snap.exists() ? snap.data() : null;
    });
  }
  function listar(){
    return Promise.all([
      getDocs(collection(db, 'empresas/' + empresaId + '/pessoas_fisicas')),
      getDocs(collection(db, 'empresas/' + empresaId + '/pessoas_juridicas'))
    ]).then(function(resultados){
      var out = [];
      resultados[0].forEach(function(d){ out.push(d.data()); });
      resultados[1].forEach(function(d){ out.push(d.data()); });
      return out;
    });
  }
  function arquivar(pessoa, arquivado){
    pessoa.arquivado = (arquivado !== false);
    return salvar(pessoa);
  }
  function excluir(pessoa){
    var chave = chaveDaPessoa(pessoa);
    if(!chave) return Promise.resolve();
    return deleteDoc(doc(db, colecaoDoTipo(pessoa.tipoPessoa), chave));
  }
  function buscarCnpj(cnpj){
    var limpo = apenasDigitos(cnpj);
    if(limpo.length !== 14) return Promise.reject(new Error('CNPJ inválido'));
    return fetch('https://brasilapi.com.br/api/cnpj/v1/' + limpo).then(function(r){
      if(!r.ok) throw new Error('CNPJ não encontrado');
      return r.json();
    });
  }
  function buscarCep(cep){
    var limpo = apenasDigitos(cep);
    if(limpo.length !== 8) return Promise.reject(new Error('CEP inválido'));
    return fetch('https://brasilapi.com.br/api/cep/v2/' + limpo).then(function(r){
      if(!r.ok) throw new Error('CEP não encontrado');
      return r.json();
    });
  }
  return {
    salvar: salvar, buscar: buscar, listar: listar,
    arquivar: arquivar, excluir: excluir,
    buscarCnpj: buscarCnpj, buscarCep: buscarCep
  };
}

// ---------- Catálogo genérico isolado por empresa (chave = slug do nome) ----------
function criarModuloCatalogoGenerico(db, colecaoNome, empresaId){
  var caminho = 'empresas/' + empresaId + '/' + colecaoNome;
  function salvar(item){
    var chave = item.id || slugify(item.nome);
    var agora = new Date().toISOString();
    var dados = Object.assign({}, item, { id: chave, atualizadoEm: agora });
    if(!dados.criadoEm) dados.criadoEm = agora;
    return setDoc(doc(db, caminho, chave), dados).then(function(){ return dados; });
  }
  function listar(){
    return getDocs(collection(db, caminho)).then(function(snap){
      var out = [];
      snap.forEach(function(d){ out.push(d.data()); });
      return out;
    });
  }
  function excluir(id){
    return deleteDoc(doc(db, caminho, id));
  }
  return { salvar: salvar, listar: listar, excluir: excluir };
}
function criarModuloProdutosServicos(db, empresaId){ return criarModuloCatalogoGenerico(db, 'produtos_servicos', empresaId); }
function criarModuloFamiliasMateriais(db, empresaId){ return criarModuloCatalogoGenerico(db, 'familias_materiais', empresaId); }

// ---------- Materiais isolado por empresa (chave = código do fabricante) ----------
function criarModuloMateriais(db, empresaId){
  var caminho = 'empresas/' + empresaId + '/materiais';
  function salvar(material){
    var chave = String(material.codigoFabricante || '').trim();
    if(!chave) return Promise.reject(new Error('Material sem código do fabricante.'));
    var agora = new Date().toISOString();
    var dados = Object.assign({}, material, { atualizadoEm: agora });
    if(!dados.criadoEm) dados.criadoEm = agora;
    return setDoc(doc(db, caminho, chave), dados).then(function(){ return dados; });
  }
  function listar(){
    return getDocs(collection(db, caminho)).then(function(snap){
      var out = [];
      snap.forEach(function(d){ out.push(d.data()); });
      return out;
    });
  }
  return { salvar: salvar, listar: listar };
}

// ---------- Espelho genérico do app (chave = nome do conjunto de dados) ----------
function criarModuloAppData(db, empresaId, nomeApp){
  var caminho = 'empresas/' + empresaId + '/' + nomeApp;
  function salvar(chave, arr){
    return setDoc(doc(db, caminho, chave), { items: arr, atualizadoEm: new Date().toISOString() })
      .then(function(){ return true; })
      .catch(function(err){ console.warn('Fênix Core (' + nomeApp + '): falha ao salvar "' + chave + '":', err); return false; });
  }
  function carregar(chave){
    return getDoc(doc(db, caminho, chave))
      .then(function(snap){ return snap.exists() ? (snap.data().items || []) : null; })
      .catch(function(err){ console.warn('Fênix Core (' + nomeApp + '): falha ao carregar "' + chave + '":', err); return null; });
  }
  return { salvar: salvar, carregar: carregar };
}

export var FenixCore = {
  versao: '1.6',
  initFirebase: initFirebase,
  criarModuloAuth: criarModuloAuth,
  criarModuloEmpresas: criarModuloEmpresas,
  criarModuloConvites: criarModuloConvites,
  criarModuloEquipe: criarModuloEquipe,
  criarModuloPessoas: criarModuloPessoas,
  criarModuloProdutosServicos: criarModuloProdutosServicos,
  criarModuloFamiliasMateriais: criarModuloFamiliasMateriais,
  criarModuloMateriais: criarModuloMateriais,
  criarModuloAppData: criarModuloAppData
};
