// ============================================================
// Fênix Core v1.5
// Módulo compartilhado entre os apps Fênix.
//
// Mudança da v1.4 pra v1.5: MULTI-EMPRESA (tenancy).
// Antes, todas as coleções compartilhadas (pessoas_fisicas,
// pessoas_juridicas, produtos_servicos, familias_materiais,
// materiais) eram um balde único — qualquer usuário autenticado via
// qualquer app Fênix lia/gravava tudo, de qualquer empresa.
//
// Agora existe uma camada de Empresa: cada empresa tem um código
// próprio (6 caracteres), e todas as coleções compartilhadas viram
// subcoleções dentro de empresas/{empresaId}/... Cada usuário fica
// associado a uma única empresa em usuarios_empresa/{uid}.
//
// Fluxo esperado em qualquer app Fênix, depois do login:
//
//   var Empresas = FenixCore.criarModuloEmpresas(db);
//   var uid = Auth.usuarioAtual().uid;
//   Empresas.obterEmpresaDoUsuario(uid).then(function(vinculo){
//     if(vinculo){
//       // usuário já pertence a uma empresa — use vinculo.empresaId
//     } else {
//       // primeiro acesso: mostrar tela de cadastro/entrada de empresa
//       // Empresas.criarEmpresa(uid, email, 'Nome da Empresa') -> cria e retorna {id, nome, ...}
//       // Empresas.entrarComCodigo(uid, email, 'ABC123') -> entra numa empresa existente
//     }
//   });
//
//   // Depois de saber o empresaId, os módulos de dados exigem esse id:
//   var Pessoas = FenixCore.criarModuloPessoas(db, empresaId);
//   var Materiais = FenixCore.criarModuloMateriais(db, empresaId);
//   ...
// ============================================================

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs, deleteDoc
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
// Código de empresa: 6 caracteres, sem 0/O/1/I pra não confundir na hora de ditar/digitar.
function gerarCodigoEmpresa(){
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var codigo = '';
  for(var i=0;i<6;i++){ codigo += chars.charAt(Math.floor(Math.random()*chars.length)); }
  return codigo;
}

// ---------- Autenticação (e-mail/senha) ----------
function criarModuloAuth(app){
  var auth = getAuth(app);
  function entrar(email, senha){ return signInWithEmailAndPassword(auth, email, senha); }
  function criarConta(email, senha){ return createUserWithEmailAndPassword(auth, email, senha); }
  function sair(){ return signOut(auth); }
  function aoMudarEstado(cb){ return onAuthStateChanged(auth, cb); }
  function usuarioAtual(){ return auth.currentUser; }
  return { entrar: entrar, criarConta: criarConta, sair: sair, aoMudarEstado: aoMudarEstado, usuarioAtual: usuarioAtual };
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
  function criarEmpresa(uid, email, nome){
    var empresaId = gerarCodigoEmpresa();
    var dadosEmpresa = { id: empresaId, nome: nome, criadoEm: new Date().toISOString(), criadoPor: email };
    return setDoc(doc(db, 'empresas', empresaId), dadosEmpresa).then(function(){
      return setDoc(doc(db, 'usuarios_empresa', uid), {
        empresaId: empresaId, email: email, papel: 'dono', entrouEm: new Date().toISOString()
      });
    }).then(function(){ return dadosEmpresa; });
  }
  function entrarComCodigo(uid, email, codigoEmpresa){
    var empresaId = String(codigoEmpresa || '').trim().toUpperCase();
    if(!empresaId) return Promise.reject(new Error('Informe o código da empresa.'));
    return getDoc(doc(db, 'empresas', empresaId)).then(function(snap){
      if(!snap.exists()) throw new Error('Código de empresa não encontrado. Confira com o responsável pela sua empresa.');
      return setDoc(doc(db, 'usuarios_empresa', uid), {
        empresaId: empresaId, email: email, papel: 'tecnico', entrouEm: new Date().toISOString()
      }).then(function(){ return snap.data(); });
    });
  }
  return {
    obterEmpresaDoUsuario: obterEmpresaDoUsuario,
    obterEmpresa: obterEmpresa,
    criarEmpresa: criarEmpresa,
    entrarComCodigo: entrarComCodigo
  };
}

// ---------- Cadastro de Pessoas (PF/PJ) — agora isolado por empresa ----------
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
// Usado por cada app Fênix (Ativos, etc.) pra guardar seu próprio estado
// (arrays inteiros tipo Soluções/Ativos/Kits) isolado por empresa.
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
  versao: '1.5',
  initFirebase: initFirebase,
  criarModuloAuth: criarModuloAuth,
  criarModuloEmpresas: criarModuloEmpresas,
  criarModuloPessoas: criarModuloPessoas,
  criarModuloProdutosServicos: criarModuloProdutosServicos,
  criarModuloFamiliasMateriais: criarModuloFamiliasMateriais,
  criarModuloMateriais: criarModuloMateriais,
  criarModuloAppData: criarModuloAppData
};
