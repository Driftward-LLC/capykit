import snapshot from './piece-catalog.json' with {type:'json'};
export interface CatalogApp {
 id:string;pieceName:string;name:string;description:string;version:string;logoUrl:string|null;
 categories:string[];actionCount:number;triggerCount:number;authentication:string[];deprecated:boolean;
 connector:string;supportedInCapykit:boolean;configured:boolean;connected:boolean;
}
export const catalogProvenance={source:snapshot.source,retrievedAt:snapshot.retrievedAt,count:snapshot.count};
export function appCatalog(native:{id:string;name:string;connector:string;configured:boolean;connected:boolean;description:string}[]=[]):CatalogApp[]{
 return snapshot.pieces.map(piece=>{const supportedInCapykit=piece.id==='github'||piece.id==='google-drive';const current=native.find(app=>app.id===piece.id);
  return {...piece,supportedInCapykit,connector:`${piece.pieceName}@${piece.version}`,configured:false,connected:false,...current};
 }).sort((a,b)=>Number(b.connected)-Number(a.connected)||Number(b.supportedInCapykit)-Number(a.supportedInCapykit)||a.name.localeCompare(b.name,'en'));
}
