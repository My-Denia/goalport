export interface PiPair { readonly provider:string; readonly model:string }
export interface PiCapacitySelection extends PiPair { readonly useExistingCapacity:true }
export interface PiCapacityMetadata {
 readonly catalog:readonly PiPair[];
 readonly offer?:PiCapacitySelection;
 readonly reason?:string;
 readonly source?:string;
 readonly workspacePath?:string;
 readonly provisional?:boolean;
 readonly defaultThinkingLevel?:string;
 readonly scopeCount?:number;
 readonly firstEnabledModel?:string|null;
 readonly defaultProvider?:string;
 readonly defaultModel?:string;
}
export function validPiIdentifier(value:unknown,max:number):value is string;
export function normalizePiCapacity(value:unknown):PiCapacitySelection|null;
export function normalizeRequestedPiCapacity(value:unknown):PiPair|null;
export function samePiPair(a:unknown,b:unknown):boolean;
export function parsePiCatalog(stdout:unknown):PiPair[]|null;
export function projectPiSettings(settings:unknown):Record<string,unknown>;
export function configuredPiOffer(settings:unknown,catalog:readonly PiPair[]|null):Omit<PiCapacityMetadata,'catalog'>;
export function piCredentialKind(auth:unknown):'oauth-only'|'apiKey-only'|'mixed'|'unreported';
export function selectedPiEligible(instance:unknown,selection?:PiCapacitySelection|null,legacy?:boolean):boolean;
