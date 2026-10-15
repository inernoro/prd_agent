import type { Page, Locator } from '@playwright/test';
type DefaultPool={isDefault?:boolean;code:string;name:string};
export function assertDefaultPeachRequest(proof:{pool:DefaultPool;selectedLabel:string;request:Record<string,unknown>}):void;
export function createDefaultWorkspaceThroughUi(page:Page,options:{runId:string;onCreated:(workspace:{id:string;title:string})=>void}):Promise<{id:string;title:string}>;
type SubmittedProof={runId:string;targetKey:string;selectedLabel:string;placement:{x:number;y:number;w:number;h:number};request:Record<string,unknown>};
export function secondaryImagePlacement(primary:SubmittedProof['placement']):{x:number;y:number};
export function submitDefaultPeachThroughUi(page:Page,options:{workspaceId:string;pool:DefaultPool;onCreated:(runId:string)=>void;beforeSubmit?:(input:Locator,model:Locator)=>Promise<void>;onSubmitted?:(proof:SubmittedProof)=>Promise<void>}):Promise<SubmittedProof>;
export function selectSupportedDefaultSizes(info:{matched?:boolean;modelId?:string;sizesNotApplicable?:boolean;sizesByResolution?:Record<string,Array<{size:string}>>},modelId:string):{square:{size:string;width:number;height:number};landscape:{size:string;width:number;height:number};portrait:{size:string;width:number;height:number}};
