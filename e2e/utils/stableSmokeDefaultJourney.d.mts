import type { Page, Locator } from '@playwright/test';
type DefaultPool={isDefault?:boolean;code:string;name:string};
export function assertDefaultPeachRequest(proof:{pool:DefaultPool;selectedLabel:string;request:Record<string,unknown>}):void;
export function createDefaultWorkspaceThroughUi(page:Page,options:{runId:string;onCreated:(workspace:{id:string;title:string})=>void}):Promise<{id:string;title:string}>;
export function submitDefaultPeachThroughUi(page:Page,options:{workspaceId:string;pool:DefaultPool;onCreated:(runId:string)=>void;beforeSubmit?:(input:Locator,model:Locator)=>Promise<void>}):Promise<{runId:string;targetKey:string;selectedLabel:string;request:Record<string,unknown>}>;
