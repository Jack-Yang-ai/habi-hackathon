/** Real TCP/HTTP protocol simulation. No ESP32, microphone, Step API or real meal. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../services/api/src/app.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'echo-esp32-http-'));
const policyBinary = path.join(scratch, 'window-policy');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1EAAAAASUVORK5CYII=', 'base64');
const compiled = spawnSync(process.env.CXX || 'clang++', ['-std=c++11', '-Wall', '-Wextra', '-Werror',
  '-I'+path.join(root,'firmware/xiao-sense/include'), path.join(root,'tools/esp32/window-policy-cli.cpp'), '-o',policyBinary], { encoding:'utf8' });
if (compiled.status !== 0) throw new Error('C++ policy compile failed: '+compiled.stderr);

class FirmwarePolicy {
  constructor() {
    this.process = spawn(policyBinary, [], { stdio:['pipe','pipe','pipe'] });
    this.lines = createInterface({ input:this.process.stdout });
  }
  async call(command) {
    const response = once(this.lines,'line',{ signal:AbortSignal.timeout(3000) });
    this.process.stdin.write(command+'\n');
    return JSON.parse((await response)[0]);
  }
  async close() {
    if(this.process.exitCode!==null){this.lines.close();return;}
    this.process.stdin.end();
    await once(this.process,'exit');
    this.lines.close();
  }
}

async function jsonRequest(url, method='GET', body, token, device=false) {
  const headers = { ...(body ? {'Content-Type':'application/json'} : {}),
    ...(token ? {[device?'X-Device-Token':'X-App-Token']:token} : {}) };
  const response = await fetch(url,{ method,headers,body:body?JSON.stringify(body):undefined,redirect:'error' });
  const payload = await response.json();
  return { status:response.status, payload };
}

const results = [];
async function scenario(name, analyses, callback) {
  const directory = path.join(scratch,name);await mkdir(directory);
  const secret = () => randomBytes(32).toString('base64url');
  const appToken=secret(), upstreamToken=secret(), deviceToken=secret();
  let clock = new Date('2026-10-15T09:00:00.000Z'), calls=0;
  const app = await createApp({ env:{ HOST:'127.0.0.1', APP_ACCESS_TOKEN:appToken, DEVICE_ACCESS_TOKEN:upstreamToken },
    dataDir:path.join(directory,'api'),clock:()=>clock,
    provider:{ visionConfigured:true,chatConfigured:false,visionModel:'deterministic-fixture-only',
      async analyze() {
        const answer=analyses[Math.min(calls++, analyses.length-1)];
        return { foodDetected:answer.food, imageQuality:answer.quality||'clear', title:'合成协议夹具',
          foods:answer.food?[{name:'合成食物标签',estimatedGrams:null}]:[],calorieRange:null,
          uncertainties:['只验证协议；并非真实食物、模型识别或摄入量'] };
      } } });
  await app.listen({ host:'127.0.0.1',port:0 });
  const base='http://127.0.0.1:'+app.server.address().port;
  const bridge=spawn(process.env.PYTHON||'python3',[path.join(root,'tools/esp32/connector.py'),'serve',
    '--host','127.0.0.1','--port','0','--upstream',base],
    { env:{...process.env,ESP32_CONNECTOR_TOKEN:deviceToken,DEVICE_ACCESS_TOKEN:upstreamToken},stdio:['ignore','pipe','pipe'] });
  const readyLines=createInterface({ input:bridge.stdout });
  let stderr='';bridge.stderr.on('data',data=>{stderr+=data;});
  const ready = await Promise.race([once(readyLines,'line',{ signal:AbortSignal.timeout(5000) }).then(([line])=>JSON.parse(line)),
    once(bridge,'exit').then(()=>{throw new Error('connector exited before ready: '+stderr);})]);
  const deviceBase='http://127.0.0.1:'+ready.port;
  let policy = new FirmwarePolicy(), sequence=0, ledger=null;
  const deviceId='fixture-'+name;
  const uptime=()=>clock.getTime()-Date.parse('2026-10-15T09:00:00.000Z');
  const deviceJson=(route,method='GET',body)=>jsonRequest(deviceBase+route,method,body,deviceToken,true);
  const appJson=(route,method='GET',body)=>jsonRequest(base+route,method,body,appToken);
  const config=()=>deviceJson('/api/device/config?device_id='+deviceId).then(r=>{assert.equal(r.status,200);return r.payload;});
  const saveLedger=async()=>{
    const target=path.join(directory,'simulated-nvs.json');
    await writeFile(target+'.pending',JSON.stringify(ledger));await rename(target+'.pending',target);
  };
  async function poll() {
    const current=await config();const window=current.capture_window;
    if(current.paused||!window)return { config:current,state:await policy.call('clear '+uptime()) };
    let remaining=window.remaining;
    if(ledger?.id===window.id)remaining=ledger.phase===window.phase&&ledger.session_id===window.session_id
      ?Math.min(remaining,ledger.remaining):0;
    else {ledger={id:window.id,phase:window.phase,session_id:window.session_id,remaining:Math.min(remaining,window.phase==='probe'?1:2)};await saveLedger();}
    const duration=Date.parse(window.expires_at)-current.epoch_ms;
    const state=await policy.call(['update',window.id,window.phase,window.session_id,uptime(),duration,remaining,uptime()].join(' '));
    return {config:current,state};
  }
  async function reserve() {
    const current=await poll();assert.equal(current.state.allowed,true,'firmware policy must allow this simulated frame');
    const before=current.state;const after=await policy.call('consume '+uptime());
    ledger.remaining=after.remaining;await saveLedger();
    const metadata={schema_version:1,capture_id:`${deviceId}-boot-${sequence}`,device_id:deviceId,boot_id:'fixture-boot',
      sequence:sequence++,captured_at:clock.toISOString(),time_source:'server',uptime_ms:uptime(),mime_type:'image/png',width:1,height:1,
      session_id:before.session_id,capture_window_id:before.id,capture_phase:before.phase};
    const queue=path.join(directory,metadata.capture_id+'.json');await writeFile(queue,JSON.stringify(metadata));
    return {metadata,queue};
  }
  async function upload(saved,keepAfterAck=false) {
    const form=new FormData();form.append('image',new Blob([png],{type:'image/png'}),'synthetic.png');
    form.append('metadata',JSON.stringify(saved.metadata));
    const response=await fetch(deviceBase+'/api/device/captures',{method:'POST',headers:{'X-Device-Token':deviceToken},body:form,redirect:'error'});
    const payload=await response.json();
    if(response.ok&&payload.capture_id===saved.metadata.capture_id&&!keepAfterAck)await rm(saved.queue,{force:true});
    return {status:response.status,payload};
  }
  async function open() {
    assert.equal((await config()).paused,true,'fresh software starts paused');
    assert.equal((await appJson('/api/device/pause','POST',{paused:false})).status,200);
    const signal=await appJson('/api/signals/context','POST',{signalId:'fixture-context-'+name,text:'你要不要吃？',
      speaker:'unknown',sourceContext:'user-conversation',observedAt:clock.toISOString(),dryRun:false});
    assert.equal(signal.status,200);assert.equal(signal.payload.signal.action,'capture_window');
    const active=await config();assert.equal(active.capture_window.phase,'probe');assert.equal(active.capture_window.remaining,1);
    return active.capture_window;
  }
  async function settle(status) {
    for(let count=0;count<100;count++) {
      const state=(await appJson('/api/state')).payload;
      if(state.device.captureReview?.status===status)return state;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('fixture review did not settle as '+status);
  }
  const context={open,poll,reserve,upload,config,settle,appJson,deviceJson,deviceBase,deviceToken,
    captures:()=>app.store.list('captures'),calls:()=>calls,advance(ms){clock=new Date(clock.getTime()+ms);},
    policyState:()=>policy.call('state '+uptime()),async restart(){await policy.close();policy=new FirmwarePolicy();ledger=JSON.parse(await readFile(path.join(directory,'simulated-nvs.json'),'utf8'));}};
  try {
    const evidence=await callback(context);
    results.push({name,passed:true,http:true,cpp_firmware_policy:true,...evidence});
  } finally {
    await policy.close();bridge.kill('SIGTERM');await once(bridge,'exit');readyLines.close();await app.close();
  }
}

try {
  await scenario('no-food',[{food:false}],async c=>{
    await c.open();const first=await c.reserve();assert.equal((await c.upload(first)).status,201);
    const state=await c.settle('no_food');assert.equal(state.meals.length,0);assert.equal((await c.poll()).state.allowed,false);
    assert.equal(c.captures().length,1);return {saved_frames:1,meals:0,stopped_after_first:true};
  });
  await scenario('food-followup',[{food:true}],async c=>{
    const probe=await c.open();const first=await c.reserve();assert.equal((await c.upload(first,true)).status,201);
    assert.equal((await c.upload(first)).status,200,'lost ACK repeats same capture, not another exposure');
    await c.settle('food_found');const followup=(await c.poll()).config.capture_window;
    assert.equal(followup.phase,'followup');assert.notEqual(followup.id,probe.id);assert.equal(followup.session_id,probe.session_id);assert.equal(followup.remaining,2);
    const second=await c.reserve();assert.equal((await c.upload(second)).status,201);
    assert.equal((await c.poll()).state.remaining,1);const third=await c.reserve();assert.equal((await c.upload(third)).status,201);
    const state=await c.settle('complete');assert.equal(state.meals.length,1);assert.equal(state.meals[0].captureCount,3);
    assert.equal((await c.poll()).state.allowed,false);assert.equal(c.calls(),1);assert.equal(c.captures().length,3);
    const forged={...third,metadata:{...third.metadata,capture_id:'fixture-over-budget',sequence:99}};
    assert.equal((await c.upload(forged)).status,409);
    return {saved_frames:3,meals:1,vision_calls:1,lost_ack_idempotent:true,over_budget_http:409};
  });
  await scenario('unclear-once',[{food:false,quality:'uncertain'}],async c=>{
    const probe=await c.open();assert.equal((await c.upload(await c.reserve())).status,201);await c.settle('waiting_retry');
    const retry=(await c.poll()).config.capture_window;assert.equal(retry.phase,'followup');assert.equal(retry.remaining,1);assert.equal(retry.session_id,probe.session_id);
    assert.equal((await c.upload(await c.reserve())).status,201);const state=await c.settle('uncertain');
    assert.equal(state.meals.length,0);assert.equal((await c.poll()).state.allowed,false);assert.equal(c.calls(),2);
    return {saved_frames:2,unclear_retries:1,meals:0};
  });
  await scenario('pause-queue',[{food:true}],async c=>{
    await c.open();const queued=await c.reserve();assert.equal((await c.appJson('/api/device/pause','POST',{paused:true})).status,200);
    assert.equal((await c.poll()).state.allowed,false);assert.equal((await c.upload(queued)).status,201,'pause does not discard an already queued frame');
    const state=await c.settle('cancelled');assert.equal(state.meals.length,0);assert.equal(c.calls(),0);
    return {new_frames_blocked:true,queued_frame_durable_ack:true,vision_calls:0};
  });
  await scenario('offline-expiry',[{food:false}],async c=>{
    await c.open();assert.equal((await c.poll()).state.allowed,true);c.advance(46000);
    assert.equal((await c.policyState()).allowed,false,'same C++ policy expires without network polling');
    assert.equal((await c.config()).capture_window,null);assert.equal(c.captures().length,0);
    return {offline_deadline_enforced:true,saved_frames:0};
  });
  await scenario('restart-budget',[{food:false}],async c=>{
    await c.open();const queued=await c.reserve();await c.restart();
    assert.equal((await c.poll()).state.allowed,false,'file-backed simulated NVS cannot refill the reserved probe');
    assert.equal((await c.upload(queued)).status,201);await c.settle('no_food');
    return {simulated_nvs_restart:true,saved_frames:1,hardware_nvs_test:false};
  });
  await scenario('connector-isolation',[{food:false}],async c=>{
    assert.equal((await jsonRequest(c.deviceBase+'/api/device/config?device_id=fixture')).status,401);
    assert.equal((await jsonRequest(c.deviceBase+'/api/device/config?device_id=fixture','GET',undefined,'wrong-token',true)).status,401);
    assert.equal((await c.deviceJson('/api/state')).status,404);
    assert.equal((await c.deviceJson('/api/device/pause','POST',{paused:false})).status,404);
    assert.equal((await c.deviceJson('/api/device/config?device_id=fixture&other=1')).status,400);
    assert.equal((await c.deviceJson('/api/device/status','POST',{device_id:'fixture',camera_ready:false,sd_ready:false,paused:true,pending_uploads:0})).status,200);
    return {unauthenticated_http:401,app_routes_not_exposed:true,status_http:200};
  });
  const report={checked_at:new Date().toISOString(),test_type:'real-loopback-http-protocol-simulation',
    hardware_camera_test:false,microphone_started:false,step_api_called:false,vision_provider:'deterministic-fixture-only',
    production_8787_contacted:false,lan_listener_opened:false,firmware_policy:'same CaptureWindowPolicy.h compiled for host',
    nvs:'file-backed simulation, not ESP32 flash or power-cut validation',passed:results.length,results};
  const output=path.join(root,'output/validation/esp32-http-e2e.json');await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {
  await rm(scratch,{recursive:true,force:true});
}
