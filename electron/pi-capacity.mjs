// Pure route/intent rules shared by the renderer, engine and native host.
// This is requested identity, never authentication, billing or spending authority.
export function validPiIdentifier(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !value.startsWith('-') && !/[\s\p{Cc}\p{Cf}*?,]/u.test(value);
}
export function normalizePiCapacity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'model,provider,useExistingCapacity'
      || value.useExistingCapacity !== true || !validPiIdentifier(value.provider,128)
      || !validPiIdentifier(value.model,256)) return null;
  return { provider:value.provider, model:value.model, useExistingCapacity:true };
}
export function normalizeRequestedPiCapacity(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!=='model,provider'
     || !validPiIdentifier(value.provider,128) || !validPiIdentifier(value.model,256)) return null;
  return {provider:value.provider,model:value.model};
}
export function samePiPair(a,b) { return !!a && !!b && a.provider === b.provider && a.model === b.model; }
export function parsePiCatalog(stdout) {
  if (typeof stdout !== 'string' || new TextEncoder().encode(stdout).length > 256*1024
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(stdout) || /\r(?!\n)/.test(stdout)) return null;
  const lines=stdout.split(/\r?\n/).filter(line=>line.trim().length);
  if (lines.shift()?.trim().split(/\s+/).join(' ') !== 'provider model context max-out thinking images') return null;
  const seen=new Set(), pairs=[];
  const count=/^(?:[1-9]\d*|(?:\d+(?:\.\d+)?)[KM])$/;
  for (const line of lines) {
    const cols=line.trim().split(/\s+/);
    if(cols.length!==6) return null;
    const [provider,model,context,maxOut,thinking,images]=cols;
    if(!validPiIdentifier(provider,128)||!validPiIdentifier(model,256)
       ||!count.test(context)||!count.test(maxOut)||parseFloat(context)<=0||parseFloat(maxOut)<=0
       ||!['yes','no'].includes(thinking)||!['yes','no'].includes(images)) return null;
    const key=JSON.stringify([provider.toLowerCase(),model.toLowerCase()]);
    if(seen.has(key)) return null;
    seen.add(key); pairs.push({provider,model});
  }
  return pairs.length ? pairs : null;
}
export function projectPiSettings(settings) {
  const s=settings && typeof settings==='object' && !Array.isArray(settings)?settings:{};
  const scope=Array.isArray(s.enabledModels)?s.enabledModels:[];
  return {
    scopeCount:s.enabledModels !== undefined && !Array.isArray(s.enabledModels) ? -1 : scope.length,
    ...(scope.length?{firstEnabledModel:typeof scope[0]==='string'?scope[0]:null}:{}),
    ...(typeof s.defaultProvider==='string'?{defaultProvider:s.defaultProvider}:{}),
    ...(typeof s.defaultModel==='string'?{defaultModel:s.defaultModel}:{}),
    ...(typeof s.defaultThinkingLevel==='string'?{defaultThinkingLevel:s.defaultThinkingLevel}:{}),
  };
}
export function configuredPiOffer(settings,catalog) {
  const unavailable={reason:'Configured Pi route could not be read; no turn was sent.'};
  if(!Array.isArray(catalog)||!catalog.length) return unavailable;
  const m=projectPiSettings(settings);
  let pair;
  const source=m.scopeCount?'First configured Pi scope entry':'Saved Pi requested choice; automatic native fallback not reproduced';
  if(m.scopeCount) {
    const raw=m.firstEnabledModel;
    const literal=catalog.filter(p=>`${p.provider}/${p.model}`===raw);
    if(literal.length>1) return unavailable;
    pair=literal[0];
    if(!pair && typeof raw==='string') {
      const stripped=raw.replace(/:(off|minimal|low|medium|high|xhigh|max)$/,'');
      if(stripped!==raw) { const matches=catalog.filter(p=>`${p.provider}/${p.model}`===stripped); if(matches.length===1) pair=matches[0]; }
    }
  } else pair=catalog.find(p=>p.provider===m.defaultProvider&&p.model===m.defaultModel);
  return pair?{offer:{...pair,useExistingCapacity:true},source,...m}: {...unavailable,source};
}
export function piCredentialKind(auth) {
  if(['oauth-only','apiKey-only','mixed','unreported'].includes(auth?.credentialKind)) return auth.credentialKind;
  return auth?.type==='apiKey'?'apiKey-only':auth?.type==='subscription'?'oauth-only':'unreported';
}
export function selectedPiEligible(instance,selection,legacy=false) {
  if(!instance || instance.instanceId!=='pi' || instance.enabled===false || instance.installed===false
     || instance.launchable===false || instance.authenticated===false || instance.availability==='unavailable'
     || instance.status==='disabled' || instance.status==='error' || instance.auth?.status==='unauthenticated'
     || instance.environmentAvoided || instance.environmentHealth
     || String(typeof instance.quota==='object'?instance.quota?.state:instance.quota).toLowerCase()==='exhausted') return false;
  if(selection) return !!normalizePiCapacity(selection) && Array.isArray(instance.piCapacity?.catalog)
    && instance.piCapacity.catalog.some(p=>samePiPair(p,selection));
  return legacy && (instance.piCredentialKind??piCredentialKind(instance.auth))!=='apiKey-only';
}
