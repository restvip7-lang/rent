import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistant, normalizePlaces, parseLocation, templatePreview } from '../assistant-service.mjs';
const point={latitude:36.54,longitude:32.05};
const elements=[
  {type:'node',id:1,lat:36.541,lon:32.05,tags:{name:'Shop',shop:'supermarket'}},
  {type:'way',id:2,center:{lat:36.541,lon:32.05},tags:{name:'Shop',shop:'supermarket'}},
  {type:'node',id:3,lat:36.542,lon:32.05,tags:{name:'Hospital',amenity:'hospital',opening_hours:'24/7'}},
  {type:'node',id:4,lat:36.543,lon:32.05,tags:{name:'Pharmacy',amenity:'pharmacy'}},
  {type:'node',id:5,lat:36.54,lon:32.05,tags:{name:'Private',amenity:'cafe',access:'private'}},
  {type:'node',id:6,lat:40,lon:32.05,tags:{name:'Far',amenity:'restaurant'}}
];
test('coordinates, deduplication, hospital category and truthful distances',()=>{
  assert.deepEqual(parseLocation('https://www.google.com/maps/@36.54,32.05,17z'),point);
  assert.equal(parseLocation('91,200'),null);
  const rows=normalizePlaces(elements,point,1500);
  assert.deepEqual(rows.map(p=>p.sourceId),['node/1','node/3','node/4']);
  assert.ok(rows[0].distanceMeters>100&&rows[0].distanceMeters<120);
  assert.equal(rows[1].openingHours,'24/7');assert.equal(rows[0].openingHours,'');
  assert.match(rows[0].detail,/не указаны/);
});
test('durable draft, cached search, selective publication, safe AI failures, templates',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'stay-assistant-test-'));
  const store={complexes:[{id:'c',rules:'Existing rules'}],apartments:[{id:'a',complexId:'c',instructions:'Existing instruction',checkout:''}],places:[],placeDrafts:{}};
  let calls=0,output=null;
  const args={getStore:()=>store,save:()=>{},dataDir:dir,env:{OVERPASS_URL:'https://maps.test/interpreter'},fetchImpl:async()=>{calls++;return{ok:true,json:async()=>({elements})};},generate:async()=>{if(output instanceof Error)throw output;return output;}};
  const service=createAssistant(args);
  try{
    const draft=await service.search({complexId:'c',...point,radius:1500});
    assert.equal(store.places.length,0);assert.equal(store.placeDrafts.c.id,draft.id);
    assert.ok(JSON.parse(readFileSync(join(dir,'assistant-cache.json'),'utf8')));
    const again=await createAssistant(args).search({complexId:'c',...point,radius:1500});
    assert.equal(again.cached,true);assert.equal(calls,1);
    const input={complexId:'c',draftId:again.id};
    await t.test('unknown ids and stale drafts cannot publish',()=>{
      assert.throws(()=>service.publish({...input,ids:['node/999']}));
      assert.throws(()=>service.publish({...input,draftId:draft.id,ids:['node/1']}));
      assert.equal(store.places.length,0);
    });
    await t.test('AI cannot replace coordinates; failed generation preserves original',async()=>{
      const before=structuredClone(again.candidates);
      output={places:[]};await assert.rejects(service.enhance(input));assert.deepEqual(again.candidates,before);
      output=Error('secret-provider-error');await assert.rejects(service.enhance(input),e=>!e.message.includes('secret-provider-error'));
      output={places:again.candidates.map(p=>({id:p.id,description:'Описание',descriptionEn:'Description',latitude:0,mapUrl:'javascript:bad'}))};
      await service.enhance(input);assert.equal(again.candidates[0].latitude,before[0].latitude);assert.equal(again.candidates[0].mapUrl,before[0].mapUrl);
    });
    await t.test('publication has stable sources and does not duplicate or overwrite edits',()=>{
      assert.equal(service.publish({...input,ids:['node/1']}).added,1);
      store.places[0].description='Manual edit';assert.equal(service.publish({...input,ids:['node/1']}).skipped,1);
      assert.equal(store.places[0].description,'Manual edit');assert.equal(store.places[0].translations.en.description,'Description');
      assert.equal(store.complexes[0].latitude,point.latitude);
    });
    await t.test('template fills blanks only unless replacement explicitly chosen',()=>{
      const texts=templatePreview({checkoutTime:'11:00'});
      assert.match(texts.checkout,/11:00/);assert.doesNotMatch(templatePreview().checkout,/\d\d:\d\d/);
      assert.throws(()=>templatePreview({quietFrom:'22:00'}));
      const result=service.applyTemplates({complexId:'c',texts,includeRules:true});assert.equal(result.updated,1);
      assert.equal(store.apartments[0].instructions,'Existing instruction');assert.equal(store.complexes[0].rules,'Existing rules');
      assert.equal(store.apartments[0].translations.en.checkout,texts.checkoutEn);assert.ok(store.complexes[0].instructionTemplate);
      service.applyTemplates({complexId:'c',texts,replaceExisting:true,includeRules:true});assert.equal(store.apartments[0].instructions,texts.instructions);assert.equal(store.complexes[0].rules,texts.rules);
    });
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('geocoder returns choices and skips network for coordinate input',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stay-geocoder-test-'));let calls=0;
  try{const service=createAssistant({getStore:()=>({}),save:()=>{},dataDir:dir,env:{},fetchImpl:async()=>{calls++;return{ok:true,json:async()=>({features:[{geometry:{coordinates:[32.05,36.54]},properties:{name:'Oba',city:'Alanya'}}]})};}});
    assert.equal((await service.geocode('36.54,32.05'))[0].exactCoordinates,true);assert.equal(calls,0);
    assert.equal((await service.geocode('Oba Alanya'))[0].label,'Oba, Alanya');await service.geocode('Oba Alanya');assert.equal(calls,1);
    await assert.rejects(service.geocode('https://maps.app.goo.gl/test'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Photon nearby categories normalize actual returned tags; errors preserve draft',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stay-photon-test-'));let broken=false;
  const store={complexes:[{id:'c'}],places:[],apartments:[],placeDrafts:{}};
  try{
    const service=createAssistant({getStore:()=>store,save:()=>{},dataDir:dir,env:{},fetchImpl:async url=>{
      if(broken)return {ok:false,status:503};
      const tag=new URL(url).searchParams.get('osm_tag');const [key,value]=tag.split(':');
      return {ok:true,json:async()=>({features:[{properties:{osm_type:'N',osm_id:Object.keys({supermarket:1,marketplace:1,pharmacy:1,hospital:1,beach:1,cafe:1,restaurant:1}).indexOf(value)+1,osm_key:key,osm_value:value,name:value},geometry:{coordinates:[32.05,36.541]}}]})};
    }});
    const draft=await service.search({complexId:'c',...point});assert.equal(draft.candidates.length,7);assert.equal(draft.missing.length,0);
    broken=true;await assert.rejects(service.search({complexId:'c',...point,radius:500}),e=>e.status===502);assert.equal(store.placeDrafts.c.id,draft.id);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
