// Deliberately messy sample code per language (plain data).
export const SAMPLES = {
  javascript: `const users=[{name:"Ann",age:31},{name:'Bob',age:27}]
function greet( user ){ if(user.age>30){return "Hello, "+user.name+"!"}
else {return 'Hi '+user.name} }
const names = users.filter(u=>u.age>20).map(u =>  greet(u)).join(", ")
export default {users,greet,names,  config:{retries:3,timeout:1000,verbose:false,endpoint:"https://example.com/api/v1/users"}}`,
  jsx: `import React,{useState} from 'react'
export function Counter({start=0,label}){const [n,setN]=useState(start)
return <div className="counter" onClick={()=>setN(n+1)}><h2>{label}</h2>
{n>0?<p>Clicked {n} times</p>:<p>Click me</p>}<button disabled={n>=10} onClick={e=>{e.stopPropagation();setN(0)}}>Reset</button></div>}`,
  typescript: `interface User{id:number;name:string;email?:string;roles:Array<'admin'|'user'>}
enum Color{Red,Green=2,Blue}
export class Repo<T extends {id:number}>{private items:Map<number,T>=new Map()
add(item:T):void{this.items.set(item.id,item)}
find=(id:number):T|undefined=>this.items.get(id)}
const u:User={id:1,name:"Ann",roles:['admin']}
export type Partialize<T>={[K in keyof T]?:T[K]}`,
  tsx: `import type {FC} from 'react'
type Props={title:string;items:string[];onPick?:(i:number)=>void}
export const List:FC<Props>=({title,items,onPick})=><section><h3>{title}</h3>
<ul>{items.map((it,i)=><li key={it} onClick={()=>onPick?.(i)}>{it}</li>)}</ul></section>`,
  css: `@import url("theme.css");
:root{--brand:#4261ee;--gap:8px}
.card,.panel>.title{display:flex;margin:0 auto;padding:var(--gap) calc(var(--gap)*2);background:linear-gradient(90deg,#fff 0%,#eee 100%)}
@media (max-width:600px){.card{flex-direction:column}}
a:hover::after{content:"→";color:RED}`,
  scss: `$brand:#4261ee;@mixin pill($c){border-radius:99px;background:$c}
.btn{&:hover{opacity:.8}.icon{margin-right:4px}@include pill($brand);
  @media (min-width:600px){padding:0 12px}}`,
  less: `@brand:#4261ee;.pill(@c){border-radius:99px;background:@c}
.btn{&:hover{opacity:.8}.pill(@brand);.icon{margin-right:4px}}`,
  html: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Demo</title>
<style>body{margin:0;font-family:sans-serif}.a{color:red}</style></head>
<body><div class="wrap"><h1 id="top">Hello</h1><p>Some <b>bold</b> and <i>italic</i> text that is long enough to need wrapping when it goes past the print width.</p>
<ul><li>One</li><li>Two</li></ul><button onclick="go( 1,2 )">Go</button></div>
<script>function go(a,b){console.log(a+b)}</script></body></html>`,
  json: `{"name":"demo","version":"1.0.0","scripts":{"start":"node index.js","test":"jest --coverage"},"keywords":["a","b"],"nested":{"list":[1,2,3,{"deep":true,"value":null}],"empty":{},"emptyList":[]}}`,
  markdown: `Title
=====
*  item one
*  item two with **bold**  and __more bold__
    * nested item

1) first
2) second

| a | b |
|---|:-:|
| longer cell | x |

\`\`\`js
const x   =  1
\`\`\``,
};
