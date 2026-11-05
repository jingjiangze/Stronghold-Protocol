import * as T from 'three';
import { Grid } from './lib/grid.js';
import { getBallProfile, getPushThreshold } from './lib/football-rules.mjs';
import {
  MATCH_STAGES, MATCH_STYLES, CARRIED_ITEMS, OPPONENT_TEAMS, createMatchState, deployOperator, deployCarriedItem,
  withdrawOperator, activateSkill, activateCarriedItem, tickMatch,
  restartBall, chooseOpponentTeam, votePause, voteSpeed, voteReady, requestCost, respondCostRequest,
} from './lib/football/match-engine.mjs';
import { decideAiTeammateCommands, pickNextControllableUnit } from './lib/football/ai-teammates.mjs';

const $ = (id) => document.getElementById(id);
const stateUi = {
  match:null, operators:[], selectedBench:null, selectedUnit:null, owner:0,
  localOwner:0, online:false, host:false, socket:null, roomId:null,
  lastBroadcast:0, lastDrawKey:'', iconUrls:{}, iconSheetText:null,
  simAccumulator:0, previousFrame:performance.now(), running:false, loading:false,
  chosenRoster:new Set(), lastError:null, lastEvents:[], resumeOnSnapshot:false, clientToken:null,
  singlePlayer:false, aiClock:0, aiOwnerIds:[1],
};

const profileNames = {
  standard:'RMA70 刺球',light:'粉红绒气球',heavy:'压缩建材球',explosive:'高能源石球',
  triple:'至纯源石球',bouncy:'无垠回荡球',leaking:'漏气甲虫球',inflating:'膨胀甲虫球',
  arctic:'北境意志球',slime:'底海滑动球',
};
const roleName = {
  vanguard:'先锋',guard:'近卫',defender:'重装',sniper:'狙击',caster:'术师',medic:'医疗',supporter:'辅助',specialist:'特种',
};
const styleName = Object.fromEntries(Object.entries(MATCH_STYLES).map(([id,data])=>[id,data.label]));
const teamName = Object.fromEntries(Object.entries(OPPONENT_TEAMS).map(([id,data])=>[id,data.label]));
const iconName = { vanguard:'role-vanguard',guard:'role-guard',defender:'role-defender',sniper:'role-sniper',caster:'role-caster',medic:'role-medic',supporter:'role-supporter',specialist:'role-specialist' };

const host = $('host');
const renderer = new T.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));
renderer.setSize(window.innerWidth,window.innerHeight,false);
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.domElement.style.background='transparent';
host.appendChild(renderer.domElement);
let pixiApp=null;
const spineAssets=new Map(),spineUnits=new Map(),spinePending=new Set();
if(window.PIXI&&window.PIXI.Application&&window.PIXI.spine){
  try{
    pixiApp=new PIXI.Application({resizeTo:window,backgroundAlpha:0,antialias:true,resolution:Math.min(2,window.devicePixelRatio||1)});
    const pixiCanvas=pixiApp.canvas||pixiApp.view;
    pixiCanvas.style.position='absolute';pixiCanvas.style.inset='0';pixiCanvas.style.pointerEvents='none';pixiCanvas.style.background='transparent';
    host.appendChild(pixiCanvas);
  }catch{pixiApp=null;}
}

const scene = new T.Scene();
scene.background = null;
const camera = new T.PerspectiveCamera(39,window.innerWidth/window.innerHeight,0.1,120);
camera.position.set(7.5,15.8,17);
camera.lookAt(6.5,0,4.5);
scene.add(new T.HemisphereLight(0xe9f4ff,0x303d4c,2.1));
const sun = new T.DirectionalLight(0xffffff,1.35);
sun.position.set(4,12,9); scene.add(sun);
const fill = new T.DirectionalLight(0x74d5ec,.45);
fill.position.set(-7,7,-2); scene.add(fill);

const raycaster = new T.Raycaster();
const pointer = new T.Vector2();
const tileMeshes = [];
const tileTopMaterials = [];
const staticScene = new T.Group(); scene.add(staticScene);
const dynamicScene = new T.Group(); scene.add(dynamicScene);
let ballMesh = null, ballArrow = null, barrierMeshes = new Map(), unitMeshes = new Map(), carriedItemMeshes = new Map();
let boardGrid = null;

function box(parent,w,h,d,color,x,y,z,materialOptions={}) {
  const mesh = new T.Mesh(new T.BoxGeometry(w,h,d),new T.MeshStandardMaterial({
    color,roughness:materialOptions.roughness??.82,metalness:materialOptions.metalness??.05,
    transparent:materialOptions.transparent??false,opacity:materialOptions.opacity??1,
  }));
  mesh.position.set(x,y,z); parent.add(mesh); return mesh;
}
function makeTile(x,y,color,inside) {
  const geom = new T.PlaneGeometry(.965,.965);
  const mat = new T.MeshStandardMaterial({color,roughness:inside?.96:.8,metalness:inside?.02:.12});
  const mesh = new T.Mesh(geom,mat);
  mesh.rotation.x=-Math.PI/2; mesh.position.set(x+.5,.025,y+.5);
  mesh.userData={gridX:x,gridY:y,kind:inside?'field':'border'};
  staticScene.add(mesh); tileMeshes.push(mesh);
  if(inside)tileTopMaterials.push(mat);
}
function addTruss(x,color,flip) {
  const group=new T.Group(); group.position.set(x,0,0); staticScene.add(group);
  const metal=new T.MeshStandardMaterial({color,metalness:.7,roughness:.35,emissive:color,emissiveIntensity:.16});
  const bar=(w,h,d,bx,by,bz,rz=0)=>{const m=new T.Mesh(new T.BoxGeometry(w,h,d),metal);m.position.set(bx,by,bz);m.rotation.z=rz;group.add(m);};
  bar(.13,5.3,.15,0,2.65,0);
  bar(.13,5.3,.15,flip*.68,2.65,0);
  bar(.13,.13,.15,flip*.34,5.25,0,0);
  bar(.12,5.2,.14,flip*.34,2.65,0,flip*.24);
  bar(.12,5.2,.14,flip*.34,2.65,0,-flip*.24);
  return group;
}
function buildStaticScene() {
  box(staticScene,13,.12,9,0x566474,6.5,-.18,4.5,{roughness:1});
  for(let y=0;y<9;y++)for(let x=0;x<13;x++){
    if(y===0||y===8){
      makeTile(x,y,(x+y)%2?0x273647:0x304255,false);
      box(staticScene,.32,.05,.09,(x%2)?0xe9a34d:0x121920,x+.5,.08,y+.08);
    } else if(x===0||x===12) {
      makeTile(x,y,x===0?0x244f8d:0x862d34,false);
    } else {
      makeTile(x,y,(x+y)%2?0xc5c9d0:0xd4d6db,true);
    }
  }
  // Cyan pitch lines, centre circle, goal boxes.
  const lineMat=new T.MeshStandardMaterial({color:0x45d9e8,emissive:0x21a4b5,emissiveIntensity:.55,roughness:.35});
  const line=(w,d,x,z)=>{const m=new T.Mesh(new T.BoxGeometry(w,.025,d),lineMat);m.position.set(x,.085,z);staticScene.add(m);};
  line(11,.045,6.5,1.13);line(11,.045,6.5,7.87);line(.045,6.75,6.5,4.5);line(.045,3,2,4.5);line(.045,3,11,4.5);
  const circle=new T.Mesh(new T.TorusGeometry(1.05,.028,8,64),new T.MeshStandardMaterial({color:0x45d9e8,emissive:0x1eafbe,emissiveIntensity:.6}));
  circle.rotation.x=Math.PI/2;circle.position.set(6.5,.1,4.5);staticScene.add(circle);
  addTruss(.45,0x367dcb,1);addTruss(12.55,0xd84b4b,-1);
  for(const x of [1.5,11.5]){
    box(staticScene,1.6,.02,4.8,0x48cfdb,x,.075,4.5,{transparent:true,opacity:.28});
  }
  // Field border strips; the CSS SVG behind the transparent canvas is the full original fallback stadium.
  line(12.8,.06,6.5,.13);line(12.8,.06,6.5,8.87);
}
buildStaticScene();

function syncCamera() {
  const aspect=window.innerWidth/window.innerHeight;
  camera.aspect=aspect;
  camera.position.set(6.5,aspect<.75?21:16,aspect<.75?21:16);
  camera.lookAt(6.5,0,4.5);
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight,false);
}
window.addEventListener('resize',syncCamera);

function parseSvgSymbolText(sheet,id) {
  const parser=new DOMParser();
  const doc=parser.parseFromString(sheet,'image/svg+xml');
  const symbol=doc.getElementById(id);
  if(!symbol)return null;
  const viewBox=symbol.getAttribute('viewBox')||'0 0 96 96';
  const children=symbol.innerHTML;
  const full='<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="'+viewBox+'">'+children+'</svg>';
  return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(full);
}
async function applyOfficialHudIfPresent() {
  try{
    const response=await fetch('/ui/football/hud_bg.png',{method:'HEAD'});
    if(response.ok){
      $('hud').style.backgroundImage='url(/ui/football/hud_bg.png)';
      $('hud').style.backgroundSize='100% 100%';
      $('hud').style.backgroundRepeat='no-repeat';
      $('hud').style.borderColor='transparent';
    }
  }catch{}
}
async function loadPublicAssets() {
  try {
    const [manifestResponse,sheetResponse]=await Promise.all([
      fetch('/assets/public/manifest.json'),fetch('/assets/public/icons.svg')
    ]);
    if(!manifestResponse.ok||!sheetResponse.ok)throw new Error('公开回退素材缺失');
    const manifest=await manifestResponse.json();
    stateUi.iconSheetText=await sheetResponse.text();
    stateUi.assetManifest=manifest;
    const names=[];
    (manifest.balls||[]).forEach(item=>names.push(item.icon.split('#').pop()));
    (manifest.styles||[]).forEach(item=>{names.push(item.icon.split('#').pop());if(item.carriedItem)names.push(item.carriedItem.icon.split('#').pop());});
    (manifest.roles||[]).forEach(item=>names.push(item.icon.split('#').pop()));
    for(const id of new Set(names)){
      const url=parseSvgSymbolText(stateUi.iconSheetText,id);
      if(url)stateUi.iconUrls[id]=url;
    }
    $('roomStatus').textContent='回退素材已加载：10 种足球、6 种比赛风格/携带物、8 种职业图标。';
    return manifest;
  }catch(error){
    $('roomStatus').textContent='资源清单载入失败：'+error.message+'；仍会使用内置形状回退。';
    return null;
  }
}
function setIcon(img,id) {
  img.src=stateUi.iconUrls[id]||'';
  if(!img.src)img.style.display='none';
}
function addLocalOfficialGroundTexture() {
  const url='/ui/scene/ground_base_tile.png';
  fetch(url,{method:'HEAD'}).then(response=>{
    if(!response.ok)return;
    return new T.TextureLoader().loadAsync(url);
  }).then(texture=>{
    if(!texture)return;
    texture.colorSpace=T.SRGBColorSpace;texture.wrapS=texture.wrapT=T.RepeatWrapping;
    texture.repeat.set(1,1);
    for(const material of tileTopMaterials){material.map=texture;material.color.set(0xffffff);material.needsUpdate=true;}
    toast('已加载本机客户端地面贴图。');
  }).catch(()=>{ /* The public original scene remains the fallback. */ });
}
addLocalOfficialGroundTexture();

function createBallMesh() {
  const geometry=new T.SphereGeometry(.26,24,18);
  const material=new T.MeshStandardMaterial({color:0xf4f6f4,roughness:.42,metalness:.04});
  ballMesh=new T.Mesh(geometry,material);dynamicScene.add(ballMesh);
  const arrowMaterial=new T.MeshBasicMaterial({color:0xffd77d});
  ballArrow=new T.ArrowHelper(new T.Vector3(1,0,0),new T.Vector3(0,.4,0),1.0,0xffd77d,.25,.15);
  ballArrow.visible=false;dynamicScene.add(ballArrow);
}
createBallMesh();

function roleTint(unit) {
  if(unit.team===1)return 0xe45b55;
  return unit.ownerId===1?0x55d4b8:0x67baf0;
}
function createUnitMesh(unit) {
  const group=new T.Group();group.userData.unitId=unit.id;
  const color=roleTint(unit);
  const base=new T.Mesh(new T.CylinderGeometry(.27,.32,.11,18),new T.MeshStandardMaterial({color:color,metalness:.18,roughness:.48}));
  base.position.y=.08;group.add(base);
  const body=new T.Mesh(new T.CapsuleGeometry(.19,.48,4,8),new T.MeshStandardMaterial({color:color,roughness:.7}));
  body.position.y=.48;group.add(body);
  const head=new T.Mesh(new T.SphereGeometry(.16,14,10),new T.MeshStandardMaterial({color:0xe1d0bd,roughness:.7}));
  head.position.set(0,.92,0);group.add(head);
  const weapon=box(group,.08,.08,.42,0xdde5ed,0,.59,.29,{metalness:.65,roughness:.25});
  weapon.rotation.x=-.25;
  const halo=new T.Mesh(new T.RingGeometry(.29,.34,32),new T.MeshBasicMaterial({color:0xffdf83,side:T.DoubleSide,transparent:true,opacity:.85}));
  halo.rotation.x=-Math.PI/2;halo.position.y=.13;halo.visible=false;group.add(halo);
  const labelCanvas=document.createElement('canvas');labelCanvas.width=128;labelCanvas.height=64;
  const ctx=labelCanvas.getContext('2d');ctx.fillStyle='#101923dd';ctx.fillRect(1,1,126,62);ctx.strokeStyle='#a6c7db';ctx.lineWidth=3;ctx.strokeRect(2,2,124,60);
  ctx.fillStyle='#f3f7fa';ctx.font='bold 24px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(String(unit.name||unit.operatorId||'?').slice(0,5),64,32);
  const labelTex=new T.CanvasTexture(labelCanvas);labelTex.colorSpace=T.SRGBColorSpace;
  const label=new T.Sprite(new T.SpriteMaterial({map:labelTex,transparent:true,depthTest:false}));
  label.position.set(0,1.42,0);label.scale.set(.95,.46,1);group.add(label);
  group.userData={unitId:unit.id,base,body,head,weapon,halo,label,labelTex,animSeed:Math.random()*Math.PI*2};
  dynamicScene.add(group);return group;
}
async function ensureSpineForUnit(unit) {
  if(!pixiApp||!window.PIXI?.spine?.Spine||spineUnits.has(unit.id)||spinePending.has(unit.id))return;
  spinePending.add(unit.id);
  try{
    const operatorId=unit.operatorId;
    const packageInfo=await (await fetch('/__chibi?dir='+encodeURIComponent(operatorId))).json();
    if(packageInfo.missing||!packageInfo.skel||!packageInfo.atlas)return;
    let data=spineAssets.get(operatorId);
    if(!data){
      const alias='football-spine-'+operatorId;
      if(!PIXI.Assets.cache.has(alias)){
        PIXI.Assets.add({alias,src:'/chibi/'+operatorId+'/'+packageInfo.skel,data:{spineAtlasFile:'/chibi/'+operatorId+'/'+packageInfo.atlas}});
      }
      const loaded=await PIXI.Assets.load(alias);
      data=loaded.spineData||loaded;
      spineAssets.set(operatorId,data);
    }
    const spine=new PIXI.spine.Spine(data);
    const names=data.animations.map(animation=>animation.name);
    const has=name=>names.includes(name);
    const initial=has('Default')?'Default':names[0];
    if(initial)spine.state.setAnimation(0,initial,true);
    spine.tint=unit.team===1?0xffaaa4:(unit.ownerId===1?0xa8ebd8:0xb3d9ff);
    pixiApp.stage.addChild(spine);
    spineUnits.set(unit.id,{spine,natH:spine.height>1?spine.height:100,has,anim:initial,team:unit.team});
  }catch{ /* The original generic unit mesh remains visible if official local assets are absent. */ }
  finally{spinePending.delete(unit.id);}
}
function updateSpineUnit(unit,record) {
  const screen=new T.Vector3(unit.x,.05,unit.y).project(camera);
  record.spine.x=(screen.x*.5+.5)*window.innerWidth;
  record.spine.y=(-screen.y*.5+.5)*window.innerHeight;
  const distance=camera.position.distanceTo(new T.Vector3(unit.x,.05,unit.y));
  const visibleWorldHeight=2*distance*Math.tan(camera.fov*Math.PI/360);
  const desiredHeight=1.12*window.innerHeight/visibleWorldHeight;
  const scale=desiredHeight/record.natH;
  const sign=unit.team===1?(unit.x>stateUi.match.ball.x?-1:1):(stateUi.match.ball.x>unit.x?1:-1);
  record.spine.scale.set(scale*sign,scale);
  record.spine.visible=unit.alive!==false;
  const desired=!unit.alive?'Die':unit.stunSeconds>0?'Stun':unit.attackCooldown<.13?'Attack':unit.team===1?'Move':'Default';
  const clip=record.has(desired)?desired:(record.has('Default')?'Default':record.anim);
  if(clip&&clip!==record.anim){record.anim=clip;record.spine.state.setAnimation(0,clip,clip==='Default'||clip==='Move'||clip==='Stun');}
}
function syncUnitMeshes() {
  const match=stateUi.match;if(!match)return;
  const units=[...(match.fieldUnits||[]),...(match.enemyUnits||[])];
  const active=new Set(units.map(unit=>unit.id));
  for(const [id,group] of unitMeshes)if(!active.has(id)){dynamicScene.remove(group);group.traverse(obj=>{if(obj.geometry)obj.geometry.dispose();if(obj.material){if(Array.isArray(obj.material))obj.material.forEach(m=>m.dispose());else obj.material.dispose();}});unitMeshes.delete(id);}
  for(const unit of units){
    let group=unitMeshes.get(unit.id);
    if(!group){group=createUnitMesh(unit);unitMeshes.set(unit.id,group);}
    const data=group.userData;
    const freshTint=roleTint(unit);
    data.base.material.color.setHex(freshTint);data.body.material.color.setHex(freshTint);
    if(!spineUnits.has(unit.id))void ensureSpineForUnit(unit);
    const spineRecord=spineUnits.get(unit.id);
    group.visible=unit.alive!==false&&!spineRecord;
    if(spineRecord)updateSpineUnit(unit,spineRecord);
    group.position.set(unit.x,.04,unit.y);
    const focus=stateUi.selectedUnit===unit.id;
    data.halo.visible=focus;
    const target=unit.team===1?{x:1,y:4.5}:stateUi.match.ball;
    const angle=Math.atan2(target.x-unit.x,target.y-unit.y);
    group.rotation.y=angle;
    const t=stateUi.match.elapsed||0;
    group.position.y=.035+Math.sin(t*3.2+data.animSeed)*.027;
    const attacking=unit.attackCooldown!==undefined&&unit.attackCooldown<.14&&unit.alive;
    data.weapon.rotation.x=attacking?-.9+Math.sin(t*30)*.3:-.25;
    if(unit.alive===false)group.scale.set(.85,.35,.85);else group.scale.set(1,1,1);
  }
}
function syncBarrierMeshes() {
  const match=stateUi.match;if(!match)return;
  const active=new Set(match.barriers.map(x=>x.id));
  for(const [id,mesh] of barrierMeshes)if(!active.has(id)){dynamicScene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();barrierMeshes.delete(id);}
  for(const barrier of match.barriers){
    let mesh=barrierMeshes.get(barrier.id);
    if(!mesh){mesh=box(dynamicScene,.78,.65,.78,0xd5a447,barrier.x,.33,barrier.y,{metalness:.35,roughness:.42});barrierMeshes.set(barrier.id,mesh);}
    mesh.position.set(barrier.x,.33,barrier.y);
    const health=barrier.hp/barrier.maxHp;mesh.material.color.setHex(health>.66?0xd5a447:health>.33?0xc77c35:0xb94c42);
  }
}
function syncCarriedItemMeshes() {
  const match=stateUi.match;if(!match)return;
  const live=new Set((match.deployedItems||[]).map(item=>item.id));
  for(const [id,mesh] of carriedItemMeshes){
    if(!live.has(id)){dynamicScene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();carriedItemMeshes.delete(id);}
  }
  const itemColors={
    'cheer-squad':0xed9e3a,'armor-distributor':0x6ab6ce,'firework-box':0x9c8add,
    'energy-drink':0xf17d5c,'soda-machine':0x79be9a,'illusion-mirror':0x87a2df
  };
  for(const item of match.deployedItems||[]){
    let mesh=carriedItemMeshes.get(item.id);
    if(!mesh){
      const group=new T.Group();
      const gem=new T.Mesh(new T.OctahedronGeometry(.27,0),new T.MeshStandardMaterial({
        color:itemColors[item.itemId]||0xd5b9f2,emissive:itemColors[item.itemId]||0x634b84,emissiveIntensity:.2,
        roughness:.35,metalness:.25
      }));
      gem.position.y=.4;group.add(gem);
      const ring=new T.Mesh(new T.TorusGeometry(.31,.025,8,28),new T.MeshBasicMaterial({color:0xf3e5a4,transparent:true,opacity:.8}));
      ring.rotation.x=Math.PI/2;ring.position.y=.1;group.add(ring);
      mesh=group;dynamicScene.add(mesh);carriedItemMeshes.set(item.id,mesh);
    }
    mesh.position.set(item.x,0,item.y);
    const pulse=1+Math.sin((stateUi.match.elapsed||0)*5)*.035;
    mesh.scale.setScalar(pulse);
  }
}
function syncBallMesh() {
  const match=stateUi.match;if(!match)return;
  const profile=getBallProfile(match.ball.type),size=match.ball.sizeScale||1;
  ballMesh.material.color.setHex(profile.color||0xf4f6f4);
  ballMesh.scale.setScalar(size);
  ballMesh.position.set(match.ball.x,.28*size,match.ball.y);
  const speed=Math.hypot(match.ball.vx,match.ball.vy);
  if(speed>.08){
    const direction=new T.Vector3(match.ball.vx,0,match.ball.vy).normalize();
    ballArrow.position.set(match.ball.x,.12,match.ball.y);
    ballArrow.setDirection(direction);ballArrow.setLength(Math.min(1.2,.4+speed*.2),.22,.13);ballArrow.visible=true;
  }else ballArrow.visible=false;
}
function refreshTerrainMeshes() {
  const match=stateUi.match;if(!match)return;
  const ice=match.iceCells||{},slime=match.slimeCells||{};
  for(const key of Object.keys(ice).concat(Object.keys(slime))){
    const [y,x]=key.split(':').map(Number),id='terrain:'+key;
    if(barrierMeshes.has(id))continue;
    const material=new T.MeshStandardMaterial({color:ice[key]?0x8edcff:0x9acb85,transparent:true,opacity:.27,roughness:.35});
    const mesh=new T.Mesh(new T.PlaneGeometry(.9,.9),material);mesh.rotation.x=-Math.PI/2;mesh.position.set(x+.5,.07,y+.5);
    dynamicScene.add(mesh);barrierMeshes.set(id,mesh);
  }
}
function pickTile(event) {
  const rect=renderer.domElement.getBoundingClientRect();
  pointer.x=((event.clientX-rect.left)/rect.width)*2-1;
  pointer.y=-((event.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer,camera);
  const intersections=raycaster.intersectObjects(tileMeshes,false);
  if(!intersections.length)return null;
  const hit=intersections[0].object.userData;
  return {x:hit.gridX,y:hit.gridY,kind:hit.kind};
}

const sceneGrid = (() => {
  const rows=[];
  for(let y=0;y<9;y++){
    let row='';
    for(let x=0;x<13;x++)row+=(y===0||y===8||x===0||x===12)?'h':'r';
    rows.push(row);
  }
  return new Grid({rows},{r0:0,r1:8,c0:0,c1:12});
})();
function canUseGridCell(x,y) {
  return x>=1&&x<=11&&y>=1&&y<=7&&sceneGrid.groundPassable(y,x);
}
function chosenPlayer() {return stateUi.match?.players.find(player=>player.id===stateUi.owner);}
function chosenUnit() {return stateUi.match?.fieldUnits.find(unit=>unit.id===stateUi.selectedUnit);}
function toast(message) {
  const node=$('toast');node.textContent=message;node.style.display='block';
  clearTimeout(stateUi.toastTimeout);stateUi.toastTimeout=setTimeout(()=>node.style.display='none',2400);
}
function escapeHtml(value) {
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function showToastFromResult(result) {
  if(result&&result.ok===false)toast('操作未执行：'+({
    'operator-not-in-bench':'干员不在待部署池','match-not-deployable':'当前阶段不可部署',
    'invalid-field-cell':'不能在界外部署','already-deployed':'干员已经部署',
    'redeploy-cooldown':'干员仍在再部署冷却','insufficient-cost':'部署费用不足',
    'deploy-limit':'超过部署上限','occupied-cell':'该格已被占用','unit-not-deployed':'干员不在场上',
    'unit-not-active':'干员当前不可行动','skill-not-found':'技能不存在','insufficient-sp':'技力不足',
    'skill-cooldown':'技能尚未就绪','ball-too-heavy-for-shift':'位移力度不足以推动此球',
    'restart-not-available':'当前没有可用的重新开球时机','item-cooldown':'携带物正在冷却',
  }[result.reason]||result.reason||'未知原因'));
  return result;
}
function broadcastSnapshot() {
  if(!stateUi.socket||stateUi.socket.readyState!==WebSocket.OPEN||!stateUi.host||!stateUi.match)return;
  try{stateUi.socket.send(JSON.stringify({type:'snapshot',roomId:stateUi.roomId,state:stateUi.match}));}catch{}
}
function sendOnlineCommand(action,payload={}) {
  if(!stateUi.socket||stateUi.socket.readyState!==WebSocket.OPEN){toast('联机链路未连接');return;}
  stateUi.socket.send(JSON.stringify({type:'command',roomId:stateUi.roomId,action,payload}));
}
function applyCommand(ownerId,action,payload={}) {
  if(!stateUi.match)return;
  let result=null;
  switch(action){
    case 'deploy': result=deployOperator(stateUi.match,ownerId,payload.operatorId,payload.x,payload.y);stateUi.match=result.state;if(result.ok){stateUi.selectedBench=null;stateUi.selectedUnit=result.unitId;}break;
    case 'withdraw': result=withdrawOperator(stateUi.match,payload.unitId);stateUi.match=result.state;if(result.ok)stateUi.selectedUnit=null;break;
    case 'skill': result=activateSkill(stateUi.match,payload.unitId,payload.skillIndex??0);stateUi.match=result.state;break;
    case 'item': result=activateCarriedItem(stateUi.match,ownerId);stateUi.match=result.state;break;
    case 'itemDeploy': result=deployCarriedItem(stateUi.match,ownerId,payload.x,payload.y);stateUi.match=result.state;if(result.ok)stateUi.selectedBench=null;break;
    case 'requestCost': result=requestCost(stateUi.match,ownerId);stateUi.match=result.state;break;
    case 'respondCost': result=respondCostRequest(stateUi.match,ownerId,payload.accept===true);stateUi.match=result.state;break;
    case 'ready': stateUi.match=voteReady(stateUi.match,ownerId,payload.ready!==false);result={ok:true};break;
    case 'restart': result=restartBall(stateUi.match,ownerId,payload.x??(ownerId===0?1.4:11.6),payload.y??4.5);stateUi.match=result.state;break;
    case 'pause': stateUi.match=votePause(stateUi.match,ownerId,payload.paused);result={ok:true};break;
    case 'speed': stateUi.match=voteSpeed(stateUi.match,ownerId,payload.fast);result={ok:true};break;
    default: result={ok:false,reason:'unknown-action'};
  }
  if(result)showToastFromResult(result);
  if(stateUi.host&&stateUi.online)broadcastSnapshot();
  stateUi.lastDrawKey='';
  renderPanels(true);
}
function dispatch(action,payload={}) {
  if(!stateUi.match)return;
  const owner=stateUi.online?stateUi.localOwner:stateUi.owner;
  if(stateUi.online&&!stateUi.host){sendOnlineCommand(action,payload);return;}
  applyCommand(owner,action,payload);
}
function getClientToken() {
  if(stateUi.clientToken)return stateUi.clientToken;
  try{
    const key='cujong-football-client-token';
    let token=localStorage.getItem(key);
    if(!token){token=crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(36).slice(2);localStorage.setItem(key,token);}
    stateUi.clientToken=token;return token;
  }catch{return 'client-'+String(Date.now())+'-'+Math.random().toString(36).slice(2);}
}
function connectOnline(mode,roomId,wsUrl) {
  const socket=new WebSocket(wsUrl);
  stateUi.socket=socket;stateUi.online=true;stateUi.host=mode==='create';stateUi.roomId=roomId||null;
  $('roomStatus').textContent='正在连接房间服务…';
  socket.addEventListener('open',()=>{
    const request={type:mode==='create'?'create':'join',roomId:roomId||'',clientName:'阵地足球玩家',clientToken:getClientToken()};
    socket.send(JSON.stringify(request));
  });
  socket.addEventListener('message',event=>{
    let message;try{message=JSON.parse(event.data);}catch{return;}
    if(message.type==='assigned'){
      stateUi.localOwner=message.ownerId;stateUi.owner=message.ownerId;stateUi.roomId=message.roomId;
      $('roomInput').value=message.roomId;
      $('roomStatus').textContent='房间 '+message.roomId+' 已连接，你是玩家 '+(message.ownerId+1)+'。';
      if(stateUi.host){
        if(message.hasSnapshot){
          stateUi.resumeOnSnapshot=true;
          $('roomStatus').textContent='正在从服务器恢复 '+message.roomId+' 的上次比赛状态…';
        }else{
          initializeMatch();
          broadcastSnapshot();
        }
      }else{
        $('roomStatus').textContent='已加入 '+message.roomId+'，等待房主同步比赛状态…';
      }
    }else if(message.type==='snapshot'&&message.state){
      if(stateUi.host&&stateUi.resumeOnSnapshot){
        stateUi.match=message.state;stateUi.resumeOnSnapshot=false;stateUi.owner=0;
        showGame();broadcastSnapshot();
      }else if(!stateUi.host){
        stateUi.match=message.state;stateUi.owner=stateUi.localOwner;showGame();
      }
      renderPanels(true);
    }else if(message.type==='command'&&stateUi.host){
      applyCommand(message.ownerId,message.action,message.payload||{});
    }else if(message.type==='peer-joined'){
      toast('玩家 '+(message.ownerId+1)+' 已加入');
      if(stateUi.host)broadcastSnapshot();
    }else if(message.type==='peer-left'){
      toast('玩家 '+(message.ownerId+1)+' 断线；房间保留等待重连');
    }else if(message.type==='error'){
      $('roomStatus').textContent='联机错误：'+(message.message||'未知错误');
      toast($('roomStatus').textContent);
    }
  });
  socket.addEventListener('close',()=>{
    if(stateUi.online)toast('联机已断开；当前状态仅保存在本浏览器。');
    $('roomStatus').textContent='WebSocket 已断开。检查是否启动了 py server/room-server.py。';
    stateUi.socket=null;
  });
  socket.addEventListener('error',()=>{
    $('roomStatus').textContent='无法连接联机服务器。先执行 py server/room-server.py，再检查 WebSocket 地址。';
  });
}
function showGame() {
  $('pick').style.display='none';
  $('hud').style.display='flex';$('topStatus').style.display='flex';
  $('leftPanel').style.display='block';$('deploymentPanel').style.display='flex';
  stateUi.running=true;renderPanels(true);
}
function selectedRosterFromUi() {
  const ids=[...stateUi.chosenRoster];
  return stateUi.operators.filter(operator=>ids.includes(operator.id));
}
function initializeMatch() {
  const operators=selectedRosterFromUi();
  if(!operators.length){toast('至少选择一名干员');return;}
  const seed=Date.now()>>>0;
  const stageId=$('stageSelect').value,styleId=$('teamStyle').value,ballType=$('ballType').value,rulesetId=$('rulesetSelect').value;
  stateUi.match=createMatchState({stageId,styleId,ballType,rulesetId,operators,seed});
  stateUi.match.mode=stateUi.singlePlayer?'single-player':'two-player';
  stateUi.match.iceCells={};stateUi.match.slimeCells={};
  stateUi.match=chooseOpponentTeam(stateUi.match,$('teamSelect').value);
  stateUi.owner=stateUi.online?stateUi.localOwner:0;
  stateUi.selectedBench=operators[0]?.id||null;stateUi.selectedUnit=null;
  stateUi.aiClock=0;
  showGame();
}
async function startFromSetup() {
  if(stateUi.loading)return;
  stateUi.loading=true;$('startMatch').disabled=true;
  const mode=$('connectionMode').value;
  try{
    if(mode==='single'){
      stateUi.online=false;stateUi.host=false;stateUi.localOwner=0;stateUi.roomId=null;stateUi.singlePlayer=true;
      initializeMatch();
    }else if(mode==='local'){
      stateUi.online=false;stateUi.host=false;stateUi.localOwner=0;stateUi.roomId=null;stateUi.singlePlayer=false;
      initializeMatch();
    }else{
      stateUi.singlePlayer=false;
      const roomId=$('roomInput').value.trim();
      const wsUrl=$('wsInput').value.trim()||'ws://127.0.0.1:8765';
      connectOnline(mode,roomId,wsUrl);
    }
  }finally{
    setTimeout(()=>{stateUi.loading=false;$('startMatch').disabled=false;},350);
  }
}
function buildRosterPicker() {
  const roster=$('rosterPick');roster.innerHTML='';
  for(const operator of stateUi.operators){
    const card=document.createElement('div');card.className='roster-option';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=stateUi.chosenRoster.has(operator.id);
    checkbox.id='pick-'+operator.id;
    checkbox.addEventListener('change',()=>{
      if(checkbox.checked)stateUi.chosenRoster.add(operator.id);else stateUi.chosenRoster.delete(operator.id);
      stateUi.lastDrawKey='';
    });
    const icon=document.createElement('img');setIcon(icon,iconName[operator.profession]||'role-guard');
    const label=document.createElement('label');label.htmlFor=checkbox.id;
    label.innerHTML=escapeHtml(operator.name||operator.id)+'<small>'+escapeHtml(roleName[operator.profession]||operator.profession||'近卫')+' · COST '+escapeHtml(operator.cost??'?')+'</small>';
    card.append(checkbox,icon,label);roster.appendChild(card);
  }
}
async function loadOperatorCatalog() {
  let data=null;
  try{
    const response=await fetch('/assets/local/operators.generated.json');
    if(response.ok)data=await response.json();
  }catch{}
  if(!data){
    const response=await fetch('/data/football/operators-fallback.json');
    if(!response.ok)throw new Error('干员回退目录读取失败');
    data=await response.json();
  }
  stateUi.operators=(data.operators||data).filter(operator=>operator&&operator.id).map(operator=>({
    ...operator,profession:operator.profession||operator.position||'guard',
    skills:Array.isArray(operator.skills)?operator.skills:[],
  }));
  stateUi.chosenRoster=new Set(stateUi.operators.map(operator=>operator.id));
  buildRosterPicker();
  if(data.status==='fallback-calibration')$('roomStatus').textContent='已加载仓库回退干员目录（数值为校准数据）；本机完整数据未找到。';
  else $('roomStatus').textContent='已加载本机干员数据：'+stateUi.operators.length+' 名。';
}
function renderBench() {
  const match=stateUi.match;if(!match)return;
  const bench=$('bench'),player=chosenPlayer();
  if(!player)return;
  const carry=CARRIED_ITEMS[MATCH_STYLES[match.styleId]?.itemId];
  const signature=player.bench.map(item=>item.id+':'+Math.ceil(match.redeployRemaining[ownerUnitKey(stateUi.owner,item.id)]||0)).join('|')+';item='+carry?.id+':'+Math.ceil(player.itemCooldownRemaining||0)+';selected='+stateUi.selectedBench+';owner='+stateUi.owner;
  if(signature===bench.dataset.signature)return;
  bench.dataset.signature=signature;bench.innerHTML='';
  for(const operator of player.bench){
    const card=document.createElement('button');card.type='button';card.className='operator-card'+(stateUi.selectedBench===operator.id?' selected':'');
    const icon=document.createElement('img');icon.className='role-icon';setIcon(icon,iconName[operator.profession]||'role-guard');
    const name=document.createElement('span');name.className='op-name';name.textContent=operator.name||operator.id;
    const meta=document.createElement('span');meta.className='op-meta';meta.textContent=(roleName[operator.profession]||operator.profession||'干员')+' · '+(operator.rarity??'—')+'★';
    const cost=document.createElement('span');cost.className='op-cost';cost.textContent='C '+(operator.cost??12);
    const cd=match.redeployRemaining[ownerUnitKey(stateUi.owner,operator.id)]||0;
    const cooldown=document.createElement('span');cooldown.className='op-meta cooldown';cooldown.textContent=cd>0?('再部署 '+Math.ceil(cd)+'s'):'待部署';
    card.append(icon,name,meta,cost,cooldown);
    card.addEventListener('click',()=>{
      stateUi.selectedBench=operator.id;stateUi.selectedUnit=null;renderPanels(true);
      toast('已选择 '+(operator.name||operator.id)+'，点击场地内格完成部署。');
    });
    bench.appendChild(card);
  }
  if(carry){
    const card=document.createElement('button');card.type='button';
    card.className='operator-card'+(stateUi.selectedBench==='__CARRIED_ITEM__'?' selected':'');
    const icon=document.createElement('img');icon.className='role-icon';setIcon(icon,'item-'+carry.id);
    const name=document.createElement('span');name.className='op-name';name.textContent=carry.label;
    const meta=document.createElement('span');meta.className='op-meta';meta.textContent='携带物 · 不占部署位';
    const cost=document.createElement('span');cost.className='op-cost';cost.textContent='C '+(carry.cost??5);
    const cooldown=document.createElement('span');cooldown.className='op-meta cooldown';
    cooldown.textContent=(player.itemCooldownRemaining||0)>0?('再部署 '+Math.ceil(player.itemCooldownRemaining)+'s'):'可部署';
    card.append(icon,name,meta,cost,cooldown);
    card.addEventListener('click',()=>{
      stateUi.selectedBench='__CARRIED_ITEM__';stateUi.selectedUnit=null;renderPanels(true);
      toast('已选择 '+carry.label+'，点击场地内格部署。');
    });
    bench.appendChild(card);
  }
}
function ownerUnitKey(owner,operatorId){return owner+':'+operatorId;}
function renderUnitControls() {
  const match=stateUi.match;if(!match)return;
  const list=$('unitControls');
  const owned=match.fieldUnits.filter(unit=>unit.ownerId===stateUi.owner);
  const signature=owned.map(unit=>unit.id+':'+Math.floor(unit.hp)+':'+Math.floor(unit.sp)+':'+unit.alive).join('|')+';sel='+stateUi.selectedUnit;
  if(signature===list.dataset.signature)return;
  list.dataset.signature=signature;list.innerHTML='';
  for(const unit of owned){
    const button=document.createElement('button');
    button.className='unit-chip'+(unit.id===stateUi.selectedUnit?' selected':'');
    button.textContent=(unit.alive?'● ':'× ')+(unit.name||unit.operatorId)+' HP '+Math.max(0,Math.floor(unit.hp))+' SP '+Math.floor(unit.sp);
    button.addEventListener('click',()=>{stateUi.selectedUnit=unit.id;stateUi.selectedBench=null;renderPanels(true);});
    list.appendChild(button);
  }
  if(!owned.length)list.textContent='场上还没有我方干员。';
}
function renderActionControls() {
  const match=stateUi.match,unit=chosenUnit();
  const selected=$('selectedLabel'),skill=$('skillButton'),withdraw=$('withdrawButton'),skillSelect=$('skillSelect');
  if(!match)return;
  if(unit){
    selected.textContent=unit.name+'｜'+(roleName[unit.profession]||unit.profession)+'｜HP '+Math.max(0,Math.floor(unit.hp))+'/'+Math.floor(unit.maxHp)+'｜SP '+Math.floor(unit.sp)+'/'+unit.maxSp;
    skill.disabled=!unit.alive||!unit.skills?.length;
    const previousSkill=Number(skillSelect.value||0);
    skillSelect.innerHTML='';
    (unit.skills||[]).forEach((entry,index)=>{
      const option=document.createElement('option');option.value=String(index);
      option.textContent=(index+1)+'. '+(entry.name||entry.id||'技能')+' · SP '+(entry.spCost??entry.costSP??20);
      skillSelect.appendChild(option);
    });
    skillSelect.disabled=!unit.skills?.length;
    skillSelect.value=String(Math.min(previousSkill,Math.max(0,(unit.skills||[]).length-1)));
    skill.textContent='释放技能';
    withdraw.disabled=false;
  }else{
    if(stateUi.selectedBench==='__CARRIED_ITEM__'){
      const carry=CARRIED_ITEMS[MATCH_STYLES[match.styleId]?.itemId];
      selected.textContent='已选择携带物：'+(carry?.label||'携带物')+'；部署费用 '+(carry?.cost??5)+'，点击场地内格部署。';
    }else{
      selected.textContent=stateUi.selectedBench?'已选择待部署干员：'+(stateUi.operators.find(x=>x.id===stateUi.selectedBench)?.name||stateUi.selectedBench)+'；点击格子部署。':'选择待部署干员或携带物，再点击场地内格部署；选择场上干员可用技能或撤退。';
    }
    skill.disabled=true;skill.textContent='释放技能';skillSelect.innerHTML='<option value="0">先选择场上干员</option>';skillSelect.disabled=true;withdraw.disabled=true;
  }
  $('cost0').textContent='P1 费用 '+match.players[0].cost;
  $('cost1').textContent=stateUi.singlePlayer?('AI 队友费用 '+match.players[1].cost):('P2 费用 '+match.players[1].cost);
  const myReady=stateUi.match.readyVotes?.[stateUi.online?stateUi.localOwner:stateUi.owner];
  $('readyButton').textContent=match.phase==='battle'?'作战进行中':match.phase==='finished'?'本局结束':myReady?'已准备，等待队友':'我已准备';
  $('readyButton').disabled=match.phase!=='deployment';
  $('pauseButton').textContent=match.paused?'恢复作战':'协同暂停';
  $('speedButton').textContent=match.speed===2?'恢复一倍速':'协同二倍速';
  const switchButton=$('switchUnitButton');
  if(switchButton)switchButton.style.display=stateUi.singlePlayer?'inline-block':'none';
  const request=match.pendingCostRequest;
  const player=chosenPlayer();
  $('requestCostButton').disabled=!!request||(player?.costRequestCooldown||0)>0||!player||player.cost>=99;
  $('requestCostButton').textContent=(player?.costRequestCooldown||0)>0?'请求费用 '+Math.ceil(player.costRequestCooldown)+'s':'请求费用';
  const canRespond=!!request&&request.responderId===stateUi.owner;
  $('acceptCostButton').style.display=canRespond?'inline-block':'none';
  $('declineCostButton').style.display=canRespond?'inline-block':'none';
  $('acceptCostButton').textContent=canRespond?'同意划拨 '+Math.min(15,match.players[stateUi.owner]?.cost||0)+' 点':'同意费用请求';
  const restartVisible=match.ballInBench&&match.restart.ownerId===stateUi.owner&&match.restart.remaining>0;
  $('restartButton').style.display=restartVisible?'inline-block':'none';
}
function renderPanels(force=false) {
  const match=stateUi.match;if(!match)return;
  const key=match.phase+':'+match.timeRemaining.toFixed(1)+':'+match.score.ally+':'+match.score.enemy+':'+match.players.map(p=>p.cost).join(':')+':'+match.fieldUnits.map(u=>u.id+u.hp+u.sp).join('|')+':'+stateUi.owner+':'+stateUi.selectedUnit+':'+stateUi.selectedBench;
  if(!force&&key===stateUi.lastDrawKey)return;
  stateUi.lastDrawKey=key;
  $('scoreAlly').textContent=match.score.ally;$('scoreEnemy').textContent=match.score.enemy;
  const seconds=Math.max(0,Math.ceil(match.timeRemaining));
  $('clock').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
  $('stagePill').textContent=MATCH_STAGES[match.stageId]?.label||match.stageId;
  $('teamPill').textContent=teamName[match.opponentTeamId]||match.opponentTeamId;
  $('ballPill').textContent=profileNames[match.ball.type]||match.ball.type;
  $('stylePill').textContent=styleName[match.styleId]||match.styleId;
  $('owner0').classList.toggle('active',stateUi.owner===0);$('owner1').classList.toggle('active',stateUi.owner===1);
  $('owner0').disabled=stateUi.online&&stateUi.localOwner!==0;$('owner1').disabled=stateUi.online&&stateUi.localOwner!==1;
  const profile=getBallProfile(match.ball.type);
  $('matchInfo').textContent='模式：'+(stateUi.singlePlayer?'单人 + 2 AI 队友':'双人协同')+'\n阶段：'+(MATCH_STAGES[match.stageId]?.label||match.stageId)+'\n球队：'+(teamName[match.opponentTeamId]||match.opponentTeamId)+'\n风格：'+(styleName[match.styleId]||match.styleId)+'\n足球：'+(profileNames[match.ball.type]||match.ball.type)+'\n推动伤害：'+Math.floor(match.ball.damage)+' / '+getPushThreshold(match.ball)+'\n重量等级：'+profile.weight+'\n球速：'+Math.hypot(match.ball.vx,match.ball.vy).toFixed(2)+'\n球员：'+match.fieldUnits.length+' 位\n当前控制：'+(stateUi.singlePlayer?(stateUi.selectedUnit?'你控制的干员':'未选择（Tab 切换）'):('玩家 '+(stateUi.owner+1)))+'\n阶段状态：'+match.phase;
  $('statusLine').textContent=match.ballInBench?'守门/阻挡后重新开球窗口：'+Math.ceil(match.restart.remaining)+' 秒。':match.phase==='deployment'?'选择干员并部署。双方确认准备后开始战斗。':match.phase==='battle'?'自动作战中：点击场上干员可选中并释放技能；点击空格可部署待部署干员。':match.phase==='finished'?'终场：净胜 '+(match.score.ally-match.score.enemy)+' 球，获得 '+match.stamps+' 枚嘉奖印章。':'';
  renderBench();renderUnitControls();renderActionControls();
  const lastEvents=match.events.slice(-5).map(event=>event.type==='GOAL'?'进球：'+event.score.ally+':'+event.score.enemy:event.type==='BALL_PUSHED'?'足球被推动':event.type==='OPERATOR_DEPLOYED'?'部署：'+event.operatorId:event.type==='OPERATOR_WITHDRAWN'?'撤退：'+event.operatorId:event.type==='UNIT_DOWN'?'球员进入喘息：'+event.unitId:event.type==='CARRY_ITEM_TRIGGERED'?'携带物触发：'+event.itemId:event.type);
  $('eventLog').innerHTML=lastEvents.map(text=>'<div class="event">'+escapeHtml(text)+'</div>').join('');
}
function updateEngine(delta) {
  if(!stateUi.match||!stateUi.running)return;
  if(stateUi.online&&!stateUi.host)return;
  if(stateUi.singlePlayer)runAiTeammates(delta);
  stateUi.simAccumulator+=Math.min(.1,delta)*(stateUi.match.speed||1);
  let ticked=false;
  while(stateUi.simAccumulator>=.05){
    stateUi.match=tickMatch(stateUi.match,.05);
    stateUi.simAccumulator-=.05;ticked=true;
  }
  if(ticked&&stateUi.online&&stateUi.host&&performance.now()-stateUi.lastBroadcast>180){
    broadcastSnapshot();stateUi.lastBroadcast=performance.now();
  }
}
/**
 * 单人模式的 AI 队友驱动：只读 state，产出命令后经 applyCommand 走同一条引擎接口。
 * 用固定节拍（约每 0.5s 决策一次）而非每帧决策，避免同帧重复部署/重复放技能。
 */
function runAiTeammates(delta) {
  if(!stateUi.match||stateUi.match.gameOver)return;
  stateUi.aiClock+=delta;
  if(stateUi.aiClock<0.5)return;
  stateUi.aiClock=0;
  const profile=getBallProfile(stateUi.match.ball.type);
  for(const ownerId of stateUi.aiOwnerIds){
    const commands=decideAiTeammateCommands(stateUi.match,ownerId,profile);
    for(const command of commands)applyCommand(ownerId,command.action,command.payload);
  }
  if(stateUi.match.phase==='finished')return;
}
function animateFrame(now) {
  const dt=Math.max(0,Math.min(.1,(now-stateUi.previousFrame)/1000));stateUi.previousFrame=now;
  updateEngine(dt);
  syncUnitMeshes();syncBarrierMeshes();syncCarriedItemMeshes();syncBallMesh();
  renderer.render(scene,camera);
  if(stateUi.match)renderPanels(false);
  requestAnimationFrame(animateFrame);
}
function tryDeployAtCell(cell) {
  if(!stateUi.match||!stateUi.selectedBench)return false;
  if(!canUseGridCell(cell.x,cell.y)){toast('不能在界外格部署。');return true;}
  if(stateUi.selectedBench==='__CARRIED_ITEM__')dispatch('itemDeploy',{x:cell.x,y:cell.y});
  else dispatch('deploy',{operatorId:stateUi.selectedBench,x:cell.x,y:cell.y});
  return true;
}
renderer.domElement.addEventListener('pointerdown',event=>{
  if(!stateUi.match||$('pick').style.display!=='none')return;
  const cell=pickTile(event);if(!cell)return;
  if(stateUi.selectedBench){tryDeployAtCell(cell);return;}
  const unit=stateUi.match.fieldUnits.find(candidate=>Math.floor(candidate.x)===cell.x&&Math.floor(candidate.y)===cell.y);
  if(unit){stateUi.selectedUnit=unit.id;stateUi.owner=unit.ownerId;stateUi.selectedBench=null;renderPanels(true);return;}
  dispatch('mark',{x:cell.x,y:cell.y});
});
$('owner0').addEventListener('click',()=>{if(stateUi.online&&stateUi.localOwner!==0)return;stateUi.owner=0;stateUi.selectedUnit=null;renderPanels(true);});
$('owner1').addEventListener('click',()=>{if(stateUi.online&&stateUi.localOwner!==1)return;stateUi.owner=1;stateUi.selectedUnit=null;renderPanels(true);});
function switchControlledUnit() {
  if(!stateUi.match||!stateUi.singlePlayer)return;
  const nextId=pickNextControllableUnit(stateUi.match,stateUi.selectedUnit);
  if(!nextId){toast('场上还没有你的干员，先从待部署区派一人上场。');return;}
  stateUi.selectedUnit=nextId;stateUi.selectedBench=null;
  renderPanels(true);
  const unit=stateUi.match.fieldUnits.find(item=>item.id===nextId);
  if(unit)toast('已切换控制：'+(unit.name||unit.operatorId));
}
$('switchUnitButton')?.addEventListener('click',switchControlledUnit);
window.addEventListener('keydown',event=>{
  if(event.key!=='Tab'||!stateUi.match||$('pick').style.display!=='none')return;
  if(!stateUi.singlePlayer)return;
  event.preventDefault();
  switchControlledUnit();
});
$('readyButton').addEventListener('click',()=>dispatch('ready',{ready:!stateUi.match?.readyVotes?.[stateUi.online?stateUi.localOwner:stateUi.owner]}));
$('pauseButton').addEventListener('click',()=>dispatch('pause',{paused:!stateUi.match?.pauseVotes?.[stateUi.online?stateUi.localOwner:stateUi.owner]}));
$('speedButton').addEventListener('click',()=>dispatch('speed',{fast:!stateUi.match?.speedVotes?.[stateUi.online?stateUi.localOwner:stateUi.owner]}));
$('skillButton').addEventListener('click',()=>{if(stateUi.selectedUnit)dispatch('skill',{unitId:stateUi.selectedUnit,skillIndex:Number($('skillSelect').value||0)});});
$('withdrawButton').addEventListener('click',()=>{if(stateUi.selectedUnit)dispatch('withdraw',{unitId:stateUi.selectedUnit});});
$('itemButton').addEventListener('click',()=>{stateUi.selectedBench='__CARRIED_ITEM__';stateUi.selectedUnit=null;renderPanels(true);toast('选择场地格部署携带物。');});
$('requestCostButton').addEventListener('click',()=>dispatch('requestCost',{}));
$('acceptCostButton').addEventListener('click',()=>dispatch('respondCost',{accept:true}));
$('declineCostButton').addEventListener('click',()=>dispatch('respondCost',{accept:false}));
$('restartButton').addEventListener('click',()=>dispatch('restart',{x:stateUi.owner===0?1.6:10.4,y:4.5}));
$('startMatch').addEventListener('click',startFromSetup);
function updateConnectionSetup() {
  const online=$('connectionMode').value!=='local'&&$('connectionMode').value!=='single';
  stateUi.singlePlayer=$('connectionMode').value==='single';
  $('onlineSetup').style.display='flex';
  $('roomInput').style.display=online?'inline-block':'none';
  $('wsInput').style.display=online?'inline-block':'none';
  $('playerBar').style.display=stateUi.singlePlayer?'none':'flex';
}
$('connectionMode').addEventListener('change',updateConnectionSetup);
$('stageSelect').addEventListener('change',()=>{
  const elite=$('stageSelect').value==='elite';
  const updated=$('rulesetSelect').value==='updated';
  $('roomStatus').textContent=elite
    ? (updated?'后续阵地足球：特级赛不享有技力需求 -20% 折扣；再部署时间不减半。':'旧版规则：特级赛仍按旧版技力折扣；再部署时间减半。')
    : (updated?'后续阵地足球规则：再部署时间不减半；技能需求 -20%，技力自然回复 ×2。':'促融共竞 #1 规则：再部署时间减半；技能需求 -20%，技力自然回复 ×2。');
});
window.__footballDebug={get state(){return stateUi.match;},get localOwner(){return stateUi.localOwner;},deploy:(id,x,y)=>dispatch('deploy',{operatorId:id,x,y}),skill:(id,i=0)=>dispatch('skill',{unitId:id,skillIndex:i}),forceRender:()=>renderPanels(true)};
(async()=>{
  try{
    await loadPublicAssets();
    await applyOfficialHudIfPresent();
    await loadOperatorCatalog();
  }catch(error){$('roomStatus').textContent='启动失败：'+error.message;}
  updateConnectionSetup();
  requestAnimationFrame(animateFrame);
})();
