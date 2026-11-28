// Engine sound DSP: individual exhaust pulses per cylinder, header runners of different lengths,
// two exhaust-pipe resonances, a saturating muffler, intake roar, turbo spool and blow-off, gear whine.
// Runs inside an AudioWorklet (registerProcessor) or, as a fallback, a ScriptProcessor on the page.
(function(){
const TAU=Math.PI*2;
const ENGINES={
  boxer:{cyl:[0,.25,.5,.75],run:[0,.9,.25,1.2],bias:[1,.86,1.04,.84],pipe:[5.4,3.1],refl:[-.52,.36],damp:.32,drive:2.0,breath:.4,pulseT:.05,rough:.13,intake:.16,
         turbo:1,whistle:.0035,spool:.05,tone:[700,3800],gain:.42,width:.12},
  five:{cyl:[0,.2,.4,.6,.8],run:[0,.35,.12,.5,.22],pipe:[4.5,2.4],refl:[-.52,.33],damp:.38,drive:2.6,breath:.5,pulseT:.042,rough:.09,intake:.2,
         turbo:1.25,whistle:.006,spool:.07,tone:[900,4800],gain:.42,width:.18},
  v6:{cyl:[0,1/6,2/6,3/6,4/6,5/6],run:[0,.55,.18,.75,.36,.95],pipe:[3.7,2.1],refl:[-.55,.33],damp:.45,drive:1.7,breath:.28,pulseT:.036,rough:.06,intake:.38,
         turbo:0,whistle:0,spool:0,tone:[1200,6400],gain:.45,width:.25},
  // --- trial profiles (24 Nov) for long sessions. Extra keys, all optional: pitch (firing rate per game rpm), asym (even
  // harmonics from a lopsided muffler = warmth), body (low-end weight), bangK/bovK/whK (scale anti-lag bangs, blow-off, gear whine)
  // smooth five: the same inline-five turbo, sanded down: gentler warble, longer rounder pulses, less rasp and hiss, quieter bangs.
  // v3 (Mark's earlier notes): tone opens wider with revs so high revs still read as high (v38 lesson); slow wander so a steady
  // speed never drones (v25 lesson); revs glide (75 ms) instead of jumping, except gear-change snaps and blips (v41 lesson); bangs and flutter a little louder again so lifts keep their aggression
  smooth5:{cyl:[0,.2,.4,.6,.8],run:[0,.16,.05,.23,.1],pipe:[4.5,2.4],refl:[-.46,.28],damp:.52,drive:1.45,breath:.16,pulseT:.052,rough:.035,intake:.1,
         turbo:1,whistle:.0007,spool:.03,tone:[600,3000],gain:.64,width:.22,asym:.15,body:.35,bangK:.45,bovK:.55,whK:.4,wander:1,glide:.075},
  // sonorous flat-six: geared to sound a little lower-revving, even firing, near-equal headers, strongly tuned pipes that sing, even harmonics; no turbo hiss
  flat6:{cyl:[0,1/6,2/6,3/6,4/6,5/6],run:[0,.08,.04,.11,.02,.07],bias:[1,.97,1.02,.98,1,.99],pipe:[4.4,2.35],refl:[-.58,.4],damp:.33,drive:1.35,breath:.12,pulseT:.036,rough:.03,intake:.16,
         turbo:0,whistle:0,spool:0,tone:[650,2300],gain:.7,width:.3,pitch:.82,asym:.35,body:.5,bangK:.4,whK:.5},
  // mellow V8: cross-plane firing into two banks (left headers short, right long) for the loping burble, geared to sound
  // like a big lazy engine at three fifths of the revs, long pipes, a deep warm muffler; overrun burbles instead of cracks
  v8:{cyl:[0,.125,.25,.375,.5,.625,.75,.875],run:[0,1.05,1.1,.05,1.0,.1,0,1.12],bias:[1,.92,.95,1.03,.9,1.02,1,.94],pipe:[6.2,3.5],refl:[-.5,.34],damp:.42,drive:1.55,breath:.2,pulseT:.032,rough:.06,intake:.14,
         turbo:0,whistle:0,spool:0,tone:[480,2300],gain:.58,width:.32,pitch:.62,asym:.25,body:.55,bangK:.5,whK:.4}
};
class EngineDSP{
  constructor(sr){this.sr=sr;const N=8192;this.M=N-1;this.col=new Float32Array(N);this.p1=new Float32Array(N);this.p2=new Float32Array(N);this.hz=new Float32Array(N);
    this.ci=0;this.pi=0;this.phase=0;this.rpm=900;this.tRpm=900;this.load=0;this.tLoad=0;this.kR=this.k(.03);this.kL=this.k(.02);
    this.amp=new Float32Array(8).fill(1);this.cut=0;this.bang=0;this.bangK=Math.exp(-1/(.05*sr));this.bph=0;this.bf=70;
    this.f1=0;this.f2=0;this.t1=0;this.t2=0;this.dcx=0;this.dcy=0;this.lo=0;this.wn1=0;this.wn2=0;this.wl1=0;this.wl2=0;this.env=0;this.ib=0;this.il=0;this.sb=0;this.sl=0;this.bb=0;this.bl=0;
    this.boost=0;this.tBoost=0;this.wph=0;this.bov=0;this.bovT=0;this.whPh=0;this.whHz=300;this.whG=0;this.master=0;this.tMaster=0;this.cutGain=1;
    this.set('boxer');}
  k(sec){return 1-Math.exp(-1/(sec*this.sr));}
  set(name){const E=ENGINES[name]||ENGINES.boxer;this.E=E;this.name=name;const sr=this.sr;
    this.dly=E.run.map(ms=>Math.round(ms*sr/1000)+2);this.L1=Math.round(E.pipe[0]*sr/1000);this.L2=Math.round(E.pipe[1]*sr/1000);
    this.win=Math.min(.45,E.pulseT*9);this.col.fill(0);this.p1.fill(0);this.p2.fill(0);}
  msg(m){if(m.engine)this.set(m.engine);if(m.rpm!==undefined){this.tRpm=m.rpm;if(m.snap)this.rpm=m.rpm;}if(m.rpmMs)this.kR=this.k(m.rpmMs/1000);else if(m.rpm!==undefined&&!m.snap&&this.E.glide)this.kR=this.k(this.E.glide);
    if(m.load!==undefined)this.tLoad=m.load;if(m.cut)this.cut=Math.max(this.cut,Math.round(m.cut*this.sr/1000));
    if(m.bang){this.bang=Math.min(1.6,this.bang+m.bang*(this.E.bangK??1));this.bf=55+Math.random()*45;this.bangK=Math.exp(-1/((.03+Math.random()*.04)*this.sr));}
    if(m.boost!==undefined)this.tBoost=m.boost;if(m.bov&&this.boost>.35){this.bov=Math.min(1,this.boost*1.1)*(this.E.bovK??1);this.bovT=0;}
    if(m.whHz!==undefined){this.whHz=m.whHz;this.whG=m.whG*(this.E.whK??1);}if(m.master!==undefined)this.tMaster=m.master;}
  svfK(fc){return 2*Math.sin(Math.PI*Math.min(fc,this.sr/7)/this.sr);}
  process(L,R){const n=L.length,sr=this.sr,E=this.E,M=this.M,nc=E.cyl.length;const pit=E.pitch||1,asym=E.asym||0,a0=asym?Math.tanh(asym):0,body=E.body||0,bodyK=1-Math.exp(-TAU*170/sr);
    // block-rate values
    const ld0=this.load,toneHz=E.tone[0]+(E.tone[1]-E.tone[0])*(.25+.75*ld0)*Math.min(1,.35+this.rpm/8000),toneK=1-Math.exp(-TAU*toneHz/sr);
    const fIn=this.svfK(260+this.rpm*.11),fSp=this.svfK(1100+this.boost*2600),fBo=this.svfK(1500+800*(1-this.bovT/.5));
    this.boost+=(this.tBoost-this.boost)*(1-Math.exp(-n/sr/(this.tBoost>this.boost?.55:.18)));
    const wHz=1600+this.boost*3400,kM=this.k(.05);
    let wP=1,wG=1;if(E.wander){const kw=1-Math.exp(-TAU*.7*n/sr);this.wn1+=((Math.random()*2-1)-this.wn1)*kw;this.wn2+=(this.wn1-this.wn2)*kw;
      this.wl1+=((Math.random()*2-1)-this.wl1)*kw;this.wl2+=(this.wl1-this.wl2)*kw;wP=1+this.wn2*.18*E.wander;wG=Math.max(.8,Math.min(1.2,1+this.wl2*3*E.wander));}
    for(let j=0;j<n;j++){
      this.rpm+=(this.tRpm-this.rpm)*this.kR;this.load+=(this.tLoad-this.load)*this.kL;
      this.phase+=this.rpm*pit*wP/120/sr;
      if(this.phase>=1){this.phase-=1;for(let i=0;i<nc;i++)this.amp[i]=(E.bias?E.bias[i]:1)*(1+E.rough*(Math.random()*2-1));}
      const cutting=this.cut>0;if(cutting)this.cut--;this.cutGain+=((cutting?.07:1)-this.cutGain)*.02;
      const pa=(.28+.72*this.load)*this.cutGain;
      for(let i=0;i<nc;i++){let p=this.phase-E.cyl[i];if(p<0)p+=1;
        if(p<this.win){const s=Math.exp(-p/E.pulseT)*(1-Math.exp(-p/(E.pulseT*.12)));const v=pa*this.amp[i]*s*(1+E.breath*(Math.random()*2-1));this.col[(this.ci+this.dly[i])&M]+=v;}}
      let x=this.col[this.ci];this.col[this.ci]=0;this.ci=(this.ci+1)&M;
      // anti-lag / overrun bang fired into the exhaust, so it rings through the pipes
      if(this.bang>.0005){this.bph+=TAU*this.bf/sr;x+=this.bang*((Math.random()*2-1)*1.1+Math.sin(this.bph)*.9);this.bang*=this.bangK;}
      this.env+=(Math.abs(x)-this.env)*.004;
      // exhaust pipes: two damped waveguide resonances
      const a=this.p1[(this.pi-this.L1)&M];this.f1+=(a-this.f1)*E.damp;const y=x+E.refl[0]*this.f1;this.p1[this.pi]=y;
      const b=this.p2[(this.pi-this.L2)&M];this.f2+=(b-this.f2)*E.damp;const z=y+E.refl[1]*this.f2;this.p2[this.pi]=z;
      this.hz[this.pi]=z;this.pi=(this.pi+1)&M;
      let o=Math.tanh(z*E.drive*(.55+.6*this.load)+asym)-a0;
      this.t1+=(o-this.t1)*toneK;this.t2+=(this.t1-this.t2)*toneK;o=this.t2;if(body){this.lo+=(o-this.lo)*bodyK;o+=this.lo*body;}
      const d=o-this.dcx+.996*this.dcy;this.dcx=o;this.dcy=d;o=d*E.gain;
      // intake roar: noise through a band that rises with revs, pulsed by the engine
      const nz=Math.random()*2-1;this.il+=fIn*this.ib;const ih=nz-this.il-.8*this.ib;this.ib+=fIn*ih;
      let side=this.ib*E.intake*(.2+this.load)*(.3+this.env*6);
      if(E.turbo){// turbo: spool rush, a faint whistle, and the blow-off flutter on a lift
        const n2=Math.random()*2-1;this.sl+=fSp*this.sb;const sh=n2-this.sl-.5*this.sb;this.sb+=fSp*sh;
        this.wph+=TAU*wHz/sr;side+=this.sb*E.spool*this.boost*this.boost+Math.sin(this.wph)*E.whistle*this.boost*this.boost;
        if(this.bov>.002){this.bovT+=1/sr;const n3=Math.random()*2-1;this.bl+=fBo*this.bb;const bh=n3-this.bl-.6*this.bb;this.bb+=fBo*bh;
          const fl=.25+.75*Math.pow(Math.max(0,Math.sin(TAU*17*this.bovT)),2);side+=this.bb*this.bov*.22*fl;this.bov*=Math.exp(-1/(.16*sr));}}
      this.whPh+=TAU*this.whHz/sr;side+=(Math.abs(((this.whPh/TAU)%1)*4-2)-1)*this.whG;
      this.master+=(this.tMaster-this.master)*kM;
      const w=this.hz[(this.pi-1-Math.round(E.width*24))&M]*E.width*.3;
      const mg=this.master*wG;let l=(o+side*.9+w)*mg,r=(o+side*1.1-w)*mg;
      L[j]=Math.tanh(l*1.2)/1.2;R[j]=Math.tanh(r*1.2)/1.2;}
  }
}
const g=typeof globalThis!=='undefined'?globalThis:self;
if(typeof registerProcessor==='function'){
  registerProcessor('engine',class extends AudioWorkletProcessor{constructor(){super();this.d=new EngineDSP(sampleRate);this.port.onmessage=e=>this.d.msg(e.data);}
    process(i,o){const out=o[0];if(out&&out[0])this.d.process(out[0],out[1]||new Float32Array(out[0].length));return true;}});
}else{g.EngineDSP=EngineDSP;g.ENGINE_PRESETS=ENGINES;}
})();
