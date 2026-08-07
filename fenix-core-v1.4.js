// ============================================================
// Fênix Core v1.4
// Módulo compartilhado entre os apps Fênix.
//
// Mudanças da v1.3 pra v1.4:
// - Cadastro de Pessoas agora usa o schema real definido nas regras
//   do Firestore: coleções 'pessoas_fisicas' (chave = CPF) e
//   'pessoas_juridicas' (chave = CNPJ), em vez de uma coleção única
//   com id aleatório.
// - Adicionado módulo de Autenticação (e-mail/senha) — as regras do
//   Firestore exigem `request.auth != null` em tudo, então todo app
//   Fênix precisa logar antes de ler/gravar.
// - Adicionados módulos de Produtos/Serviços, Famílias de Materiais
//   e Materiais (catálogo compartilhado, chave = código do fabricante).
//
// Uso básico em qualquer app Fênix:
//
//   import { FenixCore } from "https://fenicris-dev.github.io/Fenix-Levantamento-Tecnico/fenix-core-v1.4.js";
//
//   var { app, db } = FenixCore.initFirebase(firebaseConfig);
//   var Auth = FenixCore.criarModuloAuth(app);
//   Auth.aoMudarEstado(function(usuario){
//     if(usuario){ /* logado — pode ler/gravar no Firestore */ }
//     else{ /* mostrar tela/modal de login */ }
//   });
//   Auth.entrar('email@exemplo.com', 'senha123').catch(function(err){ ... });
//
//   var Pessoas = FenixCore.criarModuloPessoas(db);
//   Pessoas.salvar({ tipoPessoa:'PF', nome:'...', cpf:'...' });
//   Pessoas.listar().then(function(lista){ ... });
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

// ---------- Autenticação (e-mail/senha) ----------
// As regras do Firestore exigem request.auth != null em tudo — todo
// app Fênix precisa autenticar antes de ler/gravar dados comuns.
function criarModuloAuth(app){
  var auth = getAuth(app);

  function entrar(email, senha){
    return signInWithEmailAndPassword(auth, email, senha);
  }
  function criarConta(email, senha){
    return createUserWithEmailAndPassword(auth, email, senha);
  }
  function sair(){
    return signOut(auth);
  }
  // cb(usuario) — usuario é null quando deslogado
  function aoMudarEstado(cb){
    return onAuthStateChanged(auth, cb);
  }
  function usuarioAtual(){
    return auth.currentUser;
  }

  return {
    entrar: entrar,
    criarConta: criarConta,
    sair: sair,
    aoMudarEstado: aoMudarEstado,
    usuarioAtual: usuarioAtual
  };
}

// ---------- Cadastro de Pessoas (PF/PJ) ----------
// pessoas_fisicas/{cpf} e pessoas_juridicas/{cnpj} — chave é o próprio
// documento (só dígitos), não um id aleatório, pra evitar cadastro
// duplicado da mesma pessoa vindo de apps diferentes.
function criarModuloPessoas(db){
  function colecaoDoTipo(tipoPessoa){
    return tipoPessoa === 'PJ' ? 'pessoas_juridicas' : 'pessoas_fisicas';
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

  // Lista todas as pessoas físicas + jurídicas (as duas coleções).
  function listar(){
    return Promise.all([
      getDocs(collection(db, 'pessoas_fisicas')),
      getDocs(collection(db, 'pessoas_juridicas'))
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

// ---------- Catálogo genérico (chave = slug do nome) ----------
// Usado por Produtos/Serviços e Famílias de Materiais: coleções
// pequenas e de curadoria manual, onde o nome já identifica o item.
function criarModuloCatalogoGenerico(db, colecaoNome){
  function salvar(item){
    var chave = item.id || slugify(item.nome);
    var agora = new Date().toISOString();
    var dados = Object.assign({}, item, { id: chave, atualizadoEm: agora });
    if(!dados.criadoEm) dados.criadoEm = agora;
    return setDoc(doc(db, colecaoNome, chave), dados).then(function(){ return dados; });
  }
  function listar(){
    return getDocs(collection(db, colecaoNome)).then(function(snap){
      var out = [];
      snap.forEach(function(d){ out.push(d.data()); });
      return out;
    });
  }
  function excluir(id){
    return deleteDoc(doc(db, colecaoNome, id));
  }
  return { salvar: salvar, listar: listar, excluir: excluir };
}
function criarModuloProdutosServicos(db){ return criarModuloCatalogoGenerico(db, 'produtos_servicos'); }
function criarModuloFamiliasMateriais(db){ return criarModuloCatalogoGenerico(db, 'familias_materiais'); }

// ---------- Materiais (chave = código do fabricante) ----------
function criarModuloMateriais(db){
  function salvar(material){
    var chave = String(material.codigoFabricante || '').trim();
    if(!chave) return Promise.reject(new Error('Material sem código do fabricante.'));
    var agora = new Date().toISOString();
    var dados = Object.assign({}, material, { atualizadoEm: agora });
    if(!dados.criadoEm) dados.criadoEm = agora;
    return setDoc(doc(db, 'materiais', chave), dados).then(function(){ return dados; });
  }
  function listar(){
    return getDocs(collection(db, 'materiais')).then(function(snap){
      var out = [];
      snap.forEach(function(d){ out.push(d.data()); });
      return out;
    });
  }
  return { salvar: salvar, listar: listar };
}

export var FenixCore = {
  versao: '1.4',
  initFirebase: initFirebase,
  criarModuloAuth: criarModuloAuth,
  criarModuloPessoas: criarModuloPessoas,
  criarModuloProdutosServicos: criarModuloProdutosServicos,
  criarModuloFamiliasMateriais: criarModuloFamiliasMateriais,
  criarModuloMateriais: criarModuloMateriais
};
