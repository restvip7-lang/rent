import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../seed.mjs';
import { populateDemo } from '../demo-data.mjs';
test('realistic demo data is repeatable, linked, isolated from real delivery and preserves Wi-Fi',()=>{
  const store=structuredClone(seed);store.apartments[0].wifiPassword='UserEditedPassword';
  populateDemo(store);
  assert.equal(store.apartments.length,8);assert.equal(store.complexes.length,3);assert.equal(store.places.length,24);assert.equal(store.leads.length,12);
  assert.equal(store.apartments[0].token,'demo');assert.equal(store.apartments[0].wifiPassword,'UserEditedPassword');
  for(const s of store.stays){assert.ok(store.apartments.some(a=>a.id===s.apartmentId));assert.ok(store.contacts.some(c=>c.id===s.managerId));}
  for(const lead of store.leads){assert.equal(lead.isDemo,true);assert.equal(lead.telegramStatus,'demo');assert.ok(store.stays.some(s=>s.id===lead.stayId));}
  store.apartments[1].name='Manual name';const tokens=store.apartments.map(a=>a.token);populateDemo(store);
  assert.equal(store.apartments.length,8);assert.equal(store.places.length,24);assert.equal(store.leads.length,12);assert.equal(store.apartments[1].name,'Manual name');assert.deepEqual(store.apartments.map(a=>a.token),tokens);
});
