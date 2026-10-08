import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'stay-rental-test-'));
process.env.ADMIN_PASSWORD = 'TestOnlyPassword!';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
const { server, deliverLead } = await import('../server.mjs');

test('guest → durable lead → protected admin; CRUD, stable QR and Telegram outcomes', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie='',csrf='';
  async function call(path, method='GET', body, admin=false, headers={}) {
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(admin?{cookie,'X-CSRF-Token':csrf}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();return {status:response.status,value,response};
  }
  try {
    const guest=(await call('/api/guest?token=demo')).value;
    await t.test('private admin and unknown apartment are rejected',async()=>{
      assert.equal((await call('/api/admin/data')).status,401);
      assert.equal((await call('/api/guest?token=unknown')).status,404);
      assert.equal('leads' in guest,false);
      assert.equal((await call('/data/store.json')).status,404);
      assert.equal((await call('/api/admin/login','POST',{username:'admin',password:'incorrect'})).status,401);
    });
    const input={token:'demo',name:'Test Guest',contact:'@demo_guest',goal:'Для отдыха',budget:'€100 000–200 000',consent:true};
    await t.test('invalid contact, missing consent and wrong origin are rejected',async()=>{
      assert.equal((await call('/api/leads','POST',{...input,contact:'invalid'})).status,400);
      assert.equal((await call('/api/leads','POST',{...input,consent:false})).status,400);
      assert.equal((await call('/api/leads','POST',input,false,{Origin:'https://foreign.example'})).status,403);
    });
    let leadId;
    await t.test('lead is persisted without Telegram configuration',async()=>{
      const result=await call('/api/leads','POST',input);assert.equal(result.status,201);leadId=result.value.id;
      const stored=JSON.parse(readFileSync(join(process.env.DATA_DIR,'store.json'),'utf8')).leads.find(l=>l.id===leadId);
      assert.equal(stored.contact,input.contact);assert.equal(stored.telegramStatus,'not_configured');assert.equal(stored.managerName,'Елена');assert.equal(stored.source,guest.banner.title);assert.ok(stored.consentVersion);
    });
    await t.test('admin login provides a protected session',async()=>{
      const result=await call('/api/admin/login','POST',{username:'admin',password:'TestOnlyPassword!'});assert.equal(result.status,200);cookie=result.response.headers.get('set-cookie').split(';')[0];csrf=result.value.csrf;assert.ok(result.response.headers.get('set-cookie').includes('HttpOnly'));
      const admin=await call('/api/admin/data','GET',null,true);assert.equal(admin.status,200);assert.equal(admin.value.leads[0].id,leadId);
      assert.equal((await call('/api/admin/banner','PUT',guest.banner,true,{'X-CSRF-Token':'invalid'})).status,403);
    });
    await t.test('editing Wi-Fi preserves the printed guest token',async()=>{
      const updated=await call('/api/admin/apartments/'+guest.apartment.id,'PUT',{...guest.apartment,wifiPassword:'ChangedForTest'},true);assert.equal(updated.status,200);assert.equal(updated.value.token,'demo');
      assert.equal((await call('/api/guest?token=demo')).value.apartment.wifiPassword,'ChangedForTest');
      const qr=await fetch(base+'/api/admin/qr/'+guest.apartment.id,{headers:{cookie}});assert.equal(qr.status,200);assert.match(await qr.text(),/<svg/);
    });
    await t.test('new apartment gets a private token and reference checks protect data',async()=>{
      const created=await call('/api/admin/apartments','POST',{...guest.apartment,name:'Apartment 25'},true);assert.equal(created.status,201);assert.notEqual(created.value.token,'demo');assert.equal(created.value.token.length,36);
      assert.equal((await call('/api/guest?token='+created.value.token)).status,200);
      assert.equal((await call('/api/admin/complexes/'+guest.complex.id,'DELETE',null,true)).status,400);
      assert.equal((await call('/api/admin/contacts/'+guest.host.id,'DELETE',null,true)).status,400);
      assert.equal((await call('/api/admin/apartments/'+created.value.id,'DELETE',null,true)).status,200);
      assert.equal((await call('/api/guest?token='+created.value.token)).status,404);
      assert.equal((await call('/api/admin/apartments/'+guest.apartment.id,'PUT',{...guest.apartment,photo:'javascript:alert(1)'},true)).status,400);
    });
    await t.test('manager phone and banner edits appear on guest page',async()=>{
      assert.equal((await call('/api/admin/contacts/'+guest.manager.id,'PUT',{...guest.manager,phone:'+90 555 123 45 67'},true)).status,200);
      assert.equal((await call('/api/admin/banner','PUT',{...guest.banner,title:'Test offer'},true)).status,200);
      const current=(await call('/api/guest?token=demo')).value;assert.equal(current.manager.phone,'+90 555 123 45 67');assert.equal(current.banner.title,'Test offer');
    });
    await t.test('service requests and lead statuses persist',async()=>{
      const service=await call('/api/leads','POST',{...input,type:'service',message:'Help with Wi-Fi'});assert.equal(service.status,201);
      assert.equal((await call('/api/admin/leads/'+leadId,'PATCH',{status:'in_progress'},true)).status,200);
      assert.equal((await call('/api/admin/data','GET',null,true)).value.leads.find(l=>l.id===leadId).status,'in_progress');
    });
    await t.test('each guest link has its own manager and tracks the originating stay',async()=>{
      const manager=(await call('/api/admin/contacts','POST',{...guest.manager,name:'Мария',role:'Персональный менеджер по аренде',whatsapp:'+90 555 000 00 00'},true)).value;
      const created=await call('/api/admin/stays','POST',{name:'Test Stay',apartmentId:guest.apartment.id,managerId:manager.id,arrival:'2026-10-07',departure:'2026-10-14'},true);assert.equal(created.status,201);
      const stay=created.value;assert.equal(stay.token.length,36);
      const personalized=(await call('/api/guest?token='+stay.token)).value;assert.equal(personalized.manager.name,'Мария');assert.equal(personalized.stay.id,stay.id);assert.equal((await call('/api/guest?token=demo')).value.manager.name,'Елена');
      const qr=await fetch(base+'/api/admin/stay-qr/'+stay.id,{headers:{cookie}});assert.equal(qr.status,200);assert.match(await qr.text(),/<svg/);
      assert.equal((await call('/api/admin/contacts/'+manager.id,'DELETE',null,true)).status,400);
      const lead=await call('/api/leads','POST',{...input,token:stay.token});assert.equal(lead.status,201);
      const saved=(await call('/api/admin/data','GET',null,true)).value.leads.find(l=>l.id===lead.value.id);assert.equal(saved.stayId,stay.id);assert.equal(saved.guestName,'Test Stay');assert.equal(saved.managerName,'Мария');
      const updated=await call('/api/admin/stays/'+stay.id,'PUT',{...stay,managerId:guest.manager.id},true);assert.equal(updated.value.token,stay.token);assert.equal((await call('/api/guest?token='+stay.token)).value.manager.name,'Елена');
      assert.equal((await call('/api/admin/stays/'+stay.id,'DELETE',null,true)).status,200);assert.equal((await call('/api/guest?token='+stay.token)).status,404);
      assert.equal((await call('/api/admin/contacts/'+manager.id,'DELETE',null,true)).status,200);
    });
    await t.test('Telegram confirms success, avoids re-sending success, preserves failures',async()=>{
      const lead=structuredClone((await call('/api/admin/data','GET',null,true)).value.leads.find(l=>l.id===leadId));let requests=0;
      const fakeFetch=async(url,opts)=>{requests++;assert.ok(url.endsWith('/sendMessage'));assert.ok(JSON.parse(opts.body).text.includes(lead.id));return {ok:true,json:async()=>({ok:true,result:{message_id:42}})};};
      await deliverLead(lead,{token:'test-token',chat:'test-chat',fetch:fakeFetch});assert.equal(lead.telegramStatus,'sent');assert.equal(lead.telegramMessageId,42);
      await deliverLead(lead,{token:'test-token',chat:'test-chat',fetch:fakeFetch});assert.equal(requests,1);
      const failed={...lead,telegramStatus:'pending',retryAt:1};await deliverLead(failed,{token:'test-token',chat:'test-chat',fetch:async()=>{throw Error('network');}});assert.equal(failed.telegramStatus,'failed');assert.ok(failed.retryAt>Date.now());assert.ok(failed.telegramError);assert.ok(!failed.telegramError.includes('test-token'));
    });
    await t.test('assistant is protected; templates persist and new apartments inherit them',async()=>{
      assert.equal((await call('/api/admin/assistant/geocode','POST',{query:'36.54,32.05'})).status,401);
      assert.equal((await call('/api/admin/assistant/geocode','POST',{query:'36.54,32.05'},true,{'X-CSRF-Token':'bad'})).status,403);
      const coords=await call('/api/admin/assistant/geocode','POST',{query:'36.54,32.05'},true);assert.equal(coords.value[0].latitude,36.54);
      const texts=(await call('/api/admin/assistant/templates/preview','POST',{checkoutTime:'11:00'},true)).value;
      assert.equal((await call('/api/admin/assistant/templates/apply','POST',{complexId:guest.complex.id,texts},true)).status,200);
      const complex=(await call('/api/admin/data','GET',null,true)).value.complexes[0];
      const edited=await call('/api/admin/complexes/'+complex.id,'PUT',{...complex,name:'Edited complex'},true);assert.ok(edited.value.instructionTemplate);
      const created=await call('/api/admin/apartments','POST',{...guest.apartment,name:'Template apartment',instructions:'',checkout:''},true);
      assert.equal(created.value.instructions,texts.instructions);assert.equal(created.value.translations.en.checkout,texts.checkoutEn);
      const editedApartment=await call('/api/admin/apartments/'+created.value.id,'PUT',{...created.value,wifiName:'changed'},true);assert.equal(editedApartment.value.translations.en.checkout,texts.checkoutEn);
      const manuallyEdited=await call('/api/admin/apartments/'+created.value.id,'PUT',{...editedApartment.value,checkout:'Manual checkout'},true);assert.equal(manuallyEdited.value.translations.en.checkout,undefined);
      assert.equal((await call('/api/admin/apartments/'+created.value.id,'DELETE',null,true)).status,200);
      const publicData=(await call('/api/guest?token=demo')).value;assert.equal(publicData.placeDrafts,undefined);
    });
    await t.test('logout revokes admin session',async()=>{assert.equal((await call('/api/admin/logout','POST',null,true)).status,200);assert.equal((await call('/api/admin/data','GET',null,true)).status,401);});
  } finally { await new Promise(resolve=>server.close(resolve)); rmSync(process.env.DATA_DIR,{recursive:true,force:true}); }
});
