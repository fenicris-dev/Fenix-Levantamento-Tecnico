// ============================================================
// Fênix Core v1.3
// Módulo compartilhado entre os apps Fênix.
// Hoje cobre: inicialização única do Firebase + Cadastro de
// Pessoas (PF/PJ), com busca automática de CNPJ e CEP via
// BrasilAPI. Outros módulos comuns entram aqui no futuro.
//
// Uso básico em qualquer app Fênix:
//
//   import { FenixCore } from "https://fenicris-dev.github.io/Fenix-Levantamento-Tecnico/fenix-core-v1.3.js";
//
//   var firebaseConfig = { ...a config do projeto fenix-core-19e82... };
//   var { db } = FenixCore.initFirebase(firebaseConfig);
//   var Pessoas = FenixCore.criarModuloPessoas(db);
//
//   Pessoas.listar().then(function(lista){ ... });
//   Pessoas.salvar({ tipoPessoa:'PF', nome:'...', cpf:'...' });
//   Pessoas.buscarCnpj('00000000000000').then(function(dados){ ... });
//   Pessoas.buscarCep('49000000').then(function(dados){ ... });
// ============================================================

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- Firebase: inicialização única e compartilhada ----------
// getApps()/getApp() evitam inicializar o Firebase duas vezes caso
// o app que está importando o Core também tenha seu próprio initializeApp.
function initFirebase(firebaseConfig){
  var app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  var db = getFirestore(app);
  return { app: app, db: db };
}

function novoId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Cadastro de Pessoas (PF/PJ) ----------
// Coleção única e compartilhada entre todos os apps Fênix: 'fenixCorePessoas'.
// Cada documento é uma pessoa física ou jurídica, com o campo
// tipoPessoa ('PF' | 'PJ') decidindo quais campos fazem sentido.
function criarModuloPessoas(db){
  var COLECAO = 'fenixCorePessoas';

  function listar(){
    return getDocs(collection(db, COLECAO)).then(function(snap){
      var out = [];
      snap.forEach(function(d){ out.push(Object.assign({ id: d.id }, d.data())); });
      return out;
    });
  }

  function buscarPorId(id){
    return getDoc(doc(db, COLECAO, id)).then(function(snap){
      return snap.exists() ? Object.assign({ id: id }, snap.data()) : null;
    });
  }

  // Cria (sem id) ou atualiza (com id) uma pessoa. Retorna o objeto salvo.
  function salvar(pessoa){
    var id = pessoa.id || novoId();
    var agora = new Date().toISOString();
    var dados = Object.assign({}, pessoa, { id: id, atualizadoEm: agora });
    if(!dados.criadoEm) dados.criadoEm = agora;
    return setDoc(doc(db, COLECAO, id), dados).then(function(){ return dados; });
  }

  function arquivar(id, arquivado){
    return buscarPorId(id).then(function(pessoa){
      if(!pessoa) throw new Error('Pessoa não encontrada: ' + id);
      pessoa.arquivado = (arquivado !== false);
      return salvar(pessoa);
    });
  }

  function excluir(id){
    return deleteDoc(doc(db, COLECAO, id));
  }

  // Consulta a Receita Federal via BrasilAPI. Retorna o JSON bruto da API
  // (razao_social, nome_fantasia, logradouro, numero, bairro, municipio,
  // uf, cep, ddd_telefone_1, email, entre outros).
  function buscarCnpj(cnpj){
    var limpo = String(cnpj).replace(/\D/g, '');
    if(limpo.length !== 14) return Promise.reject(new Error('CNPJ inválido'));
    return fetch('https://brasilapi.com.br/api/cnpj/v1/' + limpo).then(function(r){
      if(!r.ok) throw new Error('CNPJ não encontrado');
      return r.json();
    });
  }

  // Consulta o CEP via BrasilAPI. Retorna {cep, state, city, neighborhood, street}.
  function buscarCep(cep){
    var limpo = String(cep).replace(/\D/g, '');
    if(limpo.length !== 8) return Promise.reject(new Error('CEP inválido'));
    return fetch('https://brasilapi.com.br/api/cep/v2/' + limpo).then(function(r){
      if(!r.ok) throw new Error('CEP não encontrado');
      return r.json();
    });
  }

  return {
    listar: listar,
    buscarPorId: buscarPorId,
    salvar: salvar,
    arquivar: arquivar,
    excluir: excluir,
    buscarCnpj: buscarCnpj,
    buscarCep: buscarCep
  };
}

export var FenixCore = {
  versao: '1.3',
  initFirebase: initFirebase,
  criarModuloPessoas: criarModuloPessoas
};
