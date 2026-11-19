import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCardCompletionGate } from '../../apps/web/src/agent/workCoordinator';

test('工作账本实际驱动：纳入、旧待办写入、版本变更、逐项验收与持久失败', async () => {
  const records = new Map<string,string>();
  let storageFull = false;
  Object.defineProperty(globalThis,'localStorage',{ configurable:true,value:{
    getItem:(key:string)=>records.get(key)??null,
    setItem:(key:string,value:string)=>{ if(storageFull) throw Error('quota'); records.set(key,value); },
    removeItem:(key:string)=>{records.delete(key);},
  }});
  const {useWorkLedger}=await import('../../apps/web/src/stores/workLedger');
  const {useTodos}=await import('../../apps/web/src/stores/todos');
  useTodos.setState({todos:[{id:'lifecycle',title:'修复缺陷',createdAt:1,done:false}]});
  useWorkLedger.setState({cards:[],links:[],sessions:[],evidences:[],events:[],actions:[]});
  const ledger=useWorkLedger.getState();
  ledger.syncWithTodos();
  await assert.rejects(ledger.updateCard('lifecycle',{enroll:true}),/目标/);
  const card=await ledger.updateCard('lifecycle',{enroll:true,goal:'修复并交付',acceptance:['测试通过','评审通过'],waitState:'waiting_input'});
  assert.equal(card.state.requirementsVersion,1);
  useTodos.getState().toggle('lifecycle');
  ledger.syncWithTodos();
  assert.equal(useWorkLedger.getState().cards[0].done,false);
  assert.equal(useWorkLedger.getState().cards[0].state.waitState,'waiting_input');
  await assert.rejects(ledger.moveCardStage('missing','done').then(r=>{if(!r.ok)throw Error(r.error);}),/不存在/);
  await assert.rejects(ledger.updateCard('lifecycle',{stage:'done',humanConfirmedDone:true}),/等待/);
  await ledger.updateCard('lifecycle',{waitState:'none'});
  await ledger.addEvidence({todoId:card.id,sessionId:null,kind:'agent_report',title:'已完成',passed:true,summary:null,headSha:null,workspaceRoot:null,webUrl:null,criterionIds:card.state.acceptance,requirementsVersion:1,contentVersion:0});
  assert.equal(evaluateCardCompletionGate(useWorkLedger.getState().cards[0],useWorkLedger.getState().evidences).canMarkDone,false);
  await assert.rejects(ledger.addEvidence({todoId:card.id,sessionId:null,kind:'manual_ack',title:'确认',passed:true,summary:null,headSha:null,workspaceRoot:null,webUrl:null}),/显式/);
  await assert.rejects(ledger.acceptWork(card.id,{actorId:'',criterionIds:card.state.acceptance,requirementsVersion:1,contentVersion:0}),/身份/);
  await assert.rejects(ledger.acceptWork(card.id,{actorId:'alice',criterionIds:['测试通过'],requirementsVersion:1,contentVersion:0}),/评审通过/);
  assert.equal(useWorkLedger.getState().evidences.length,1);
  const accepted=await ledger.acceptWork(card.id,{actorId:'server:alice',criterionIds:card.state.acceptance,requirementsVersion:1,contentVersion:0});
  assert.equal(accepted.done,true);
  const human=useWorkLedger.getState().evidences[0];
  assert.equal(human.acceptedBy,'server:alice');
  const rework=await ledger.updateCard(card.id,{rework:true,note:'补充边界条件'});
  assert.equal(rework.id,card.id);
  assert.equal(rework.state.contentVersion,1);
  assert.equal(rework.state.requirementsVersion,2);
  await assert.rejects(ledger.acceptWork(card.id,{actorId:'server:alice',criterionIds:card.state.acceptance,requirementsVersion:1,contentVersion:0}),/当前版本/);
  await assert.rejects(ledger.updateCard(card.id,{goal:'旧请求试图覆盖',expectedRequirementsVersion:1,expectedContentVersion:0}),/当前版本/);
  assert.equal(useWorkLedger.getState().cards[0].state.goal,'修复并交付');
  assert.ok(useWorkLedger.getState().evidences.every(e=>e.stale));
  storageFull=true;
  const before=useWorkLedger.getState().cards[0];
  await assert.rejects(ledger.updateCard(card.id,{waitState:'paused'}),/持久/);
  assert.equal(useWorkLedger.getState().cards[0],before);
  await assert.rejects(ledger.prepareDispatchAction({todoId:card.id,idempotencyKey:'failed-persist',actionKind:'rc_report',specJson:'{}'}),/持久/);
  assert.equal(useWorkLedger.getState().actions.length,0);
  storageFull=false;
  const action=await ledger.prepareDispatchAction({todoId:card.id,idempotencyKey:'cas',actionKind:'session_create',specJson:'{}'});
  const frozen=JSON.parse(action.specJson);
  assert.equal(frozen.requirementsVersion,2);
  await ledger.transitionDispatchAction({id:action.id,state:'dispatched',expectedState:'awaiting_approval'});
  await assert.rejects(ledger.transitionDispatchAction({id:action.id,state:'dispatched',expectedState:'awaiting_approval'}),/更新/);
  await ledger.updateCard(card.id,{autonomyMode:'autonomous',maxAutoTurns:3});
  for(let turn=0;turn<3;turn++) {
    await ledger.prepareDispatchAction({todoId:card.id,idempotencyKey:`turn-${turn}`,actionKind:'session_create',specJson:'{}',requireConfirmation:false});
  }
  assert.equal(useWorkLedger.getState().cards[0].state.autoTurnsUsed,3);
  for(const actionKind of ['ado_state_write','rc_report'] as const) {
    assert.equal((await ledger.prepareDispatchAction({todoId:card.id,idempotencyKey:actionKind,actionKind,specJson:'{}',requireConfirmation:false})).state,'prepared');
  }
  assert.equal(useWorkLedger.getState().cards[0].state.autoTurnsUsed,3);
  await assert.rejects(ledger.prepareDispatchAction({todoId:card.id,idempotencyKey:'fourth-turn',actionKind:'session_create',specJson:'{}',requireConfirmation:false}),/预算/);
});
