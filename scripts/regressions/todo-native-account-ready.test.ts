import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function deferred<T>() {
  let resolve!: (value:T)=>void;
  let reject!: (reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const tick=()=>new Promise<void>((resolve)=>setImmediate(resolve));
async function until(check:()=>boolean) {
  for(let n=0;n<100;n++) { if(check())return; await tick(); }
  assert.fail('待办就绪条件未满足');
}
async function nativeScenario(mode:string) {
  if(mode==='context') {
    const account=await import('../../apps/web/src/platform/butlerAccountReady');
    assert.throws(account.captureButlerRuntimeAccountContext,/尚未就绪/);
    const a=account.beginButlerAccountSelection('A');
    assert.throws(account.captureButlerRuntimeAccountContext,/尚未就绪/);
    a.activate({accountScope:'A',generation:1});
    const captured=account.captureButlerRuntimeAccountContext();
    captured.accountScope='mutated';
    assert.deepEqual(account.captureButlerRuntimeAccountContext(),{accountScope:'A',generation:1});
    const oldGuard=account.captureButlerAccountGeneration();
    const b=account.beginButlerAccountSelection('B');
    assert.throws(oldGuard,/账号已切换/);
    assert.throws(account.captureButlerRuntimeAccountContext,/尚未就绪/);
    assert.throws(()=>a.activate({accountScope:'A',generation:3}),/账号已切换/);
    assert.throws(()=>b.activate({accountScope:'A',generation:2}),/作用域或代际/);
    assert.throws(()=>b.activate({accountScope:'B',generation:1}),/作用域或代际/);
    b.activate({accountScope:'B',generation:2});
    const again=account.beginButlerAccountSelection('B');
    assert.throws(()=>again.activate({accountScope:'B',generation:2}),/作用域或代际/);
    again.activate({accountScope:'B',generation:3});
    assert.deepEqual(account.captureButlerRuntimeAccountContext(),{accountScope:'B',generation:3});
    process.stdout.write(`TODO_ACCOUNT_READY:${mode}:passed\n`);
    return;
  }
  const records=new Map<string,string>();
  records.set('rcx-todos',JSON.stringify([{id:'legacy-private',title:'旧账号隐私',done:false,createdAt:1}]));
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>records.get(k)??null,setItem:(k:string,v:string)=>records.set(k,v),removeItem:(k:string)=>records.delete(k)}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:globalThis});
  const selectingA=deferred<void>();
  const lateRead=deferred<unknown[]>();
  const lateWrite=deferred<unknown>();
  const migrateA=deferred<number>();
  const migrateB=deferred<number>();
  const calls:Array<{command:string;scope:string;id?:unknown}>=[];
  let scope='legacy-unselected';
  let nativeGeneration=0;
  let holdRead=mode==='read';
  let holdWrite=mode.startsWith('write');
  const item=(owner:string)=>({id:owner,title:`${owner} 的待办`,source:'manual',done:false,priority:1,createdAt:1,updatedAt:1});
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:(command:string,args:Record<string,unknown>={})=>{
    calls.push({command,scope,id:args.id});
    if(command==='butler_db_select_account') {
      const next=String(args.accountScope);
      records.set('rcx-owner',next);
      const nextGeneration=++nativeGeneration;
      return (next==='A' && !mode.startsWith('write') ? selectingA.promise : Promise.resolve()).then(()=>{scope=next;return {accountScope:next,generation:nextGeneration};});
    }
    if(command==='butler_todo_migrate_from_json') {
      if(mode==='migration') return scope==='A'?migrateA.promise:migrateB.promise;
      return Promise.resolve(1);
    }
    if(command==='butler_todo_list') {
      if(scope==='A' && holdRead) {holdRead=false;return lateRead.promise;}
      return Promise.resolve([item(scope)]);
    }
    if(command==='butler_todo_update') {
      if(scope==='A' && holdWrite) {holdWrite=false;return lateWrite.promise;}
      return Promise.resolve({...item(scope),...(args.patch as object)});
    }
    throw Error(`未预期命令：${command}`);
  }}});
  const todos=await import('../../apps/web/src/stores/todos');
  const platform=await import('../../apps/web/src/platform/desktopCommands');
  await tick();await tick();
  assert.deepEqual(calls,[],'导入store不能读取尚未选定的旧数据库');
  assert.deepEqual(todos.useTodos.getState().todos,[],'账号就绪前不能显示旧localStorage待办');
  if(mode==='read'||mode==='migration') {
    const a=platform.selectNativeButlerAccount('A');
    await tick();
    assert.deepEqual(calls.map(c=>c.command),['butler_db_select_account']);
    selectingA.resolve();await a;
    await until(()=>calls.some(c=>c.command===(mode==='migration'?'butler_todo_migrate_from_json':'butler_todo_list')&&c.scope==='A'));
    const bLegacy=JSON.stringify([{id:'B-legacy',title:'B的迁移待办',done:false,createdAt:1}]);
    if(mode==='migration') records.set('rcx-todos',bLegacy);
    await platform.selectNativeButlerAccount('B');
    if(mode==='migration') {
      await until(()=>calls.some(c=>c.command==='butler_todo_migrate_from_json'&&c.scope==='B'));
      migrateA.resolve(1);await tick();await tick();
      assert.equal(records.get('rcx-todos'),bLegacy,'A的迟到迁移不得删除B的旧数据');
      migrateB.resolve(1);
    }
    await until(()=>todos.useTodos.getState().todos[0]?.id==='B');
    lateRead.resolve([item('A')]);
    await tick();await tick();
    assert.deepEqual(todos.useTodos.getState().todos.map(t=>t.id),['B']);
  } else if(mode.startsWith('write')) {
    await platform.selectNativeButlerAccount('A');
    await until(()=>todos.useTodos.getState().todos[0]?.id==='A');
    todos.useTodos.getState().update('A',{note:'A 尚在写入'});
    const oldWrite=todos.awaitLastTodoWrite();void oldWrite.catch(()=>undefined);
    await until(()=>calls.some(c=>c.command==='butler_todo_update'&&c.scope==='A'));
    todos.useTodos.getState().toggle('A');
    const queued=todos.awaitLastTodoWrite();void queued.catch(()=>undefined);
    await platform.selectNativeButlerAccount('B');
    await until(()=>todos.useTodos.getState().todos[0]?.id==='B');
    todos.useTodos.getState().update('B',{note:'B 的修改'});
    await todos.awaitLastTodoWrite();
    if(mode==='write_error') lateWrite.reject(Error('A原库写入失败'));
    else lateWrite.resolve({...item('A'),note:'A 的晚回执'});
    await assert.rejects(oldWrite,/账号|数据库/);
    await assert.rejects(queued,/账号|数据库/);
    assert.deepEqual(todos.useTodos.getState().todos.map(t=>[t.id,t.note]),[['B','B 的修改']]);
    assert.equal(calls.some(c=>c.scope==='B'&&c.id==='A'),false,'旧队列不能向新库发送旧待办写入');
  } else {
    const waiting=platform.listNativeTodos();void waiting.catch(()=>undefined);
    const a=platform.selectNativeButlerAccount('A');void a.catch(()=>undefined);
    await tick();
    if(mode==='failure') {
      selectingA.reject(Error('账号选择失败'));
      await assert.rejects(a,/选择失败/);
      await assert.rejects(waiting,/选择失败/);
      assert.equal(calls.some(c=>c.command.startsWith('butler_todo_')),false);
      await platform.selectNativeButlerAccount('B');
    } else {
      const b=platform.selectNativeButlerAccount('B');
      selectingA.resolve();
      await assert.rejects(a,/账号|数据库/);
      await b;
      await waiting;
      assert.equal(calls.some(c=>c.command.startsWith('butler_todo_')&&c.scope!=='B'),false);
    }
    await until(()=>todos.useTodos.getState().todos[0]?.id==='B');
  }
  process.stdout.write(`TODO_ACCOUNT_READY:${mode}:passed\n`);
}

if(process.env.RCX_TODO_READY_CHILD) {
  void nativeScenario(process.env.RCX_TODO_READY_CHILD).catch(error=>{process.stderr.write(String(error?.stack??error));process.exitCode=1;});
} else {
  for(const mode of ['read','write','write_error','migration','failure','serial','context']) test(`原生待办账号就绪与代际隔离：${mode}`,()=>{
    const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url)],{env:{...process.env,RCX_TODO_READY_CHILD:mode},encoding:'utf8',timeout:20000});
    assert.equal(child.status,0,`${child.stdout}\n${child.stderr}\n${child.error??''}`);
    assert.match(child.stdout,new RegExp(`TODO_ACCOUNT_READY:${mode}:passed`));
  });
}
