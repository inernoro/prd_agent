import { CLOSED_LID, EYE_X, OPEN_UPPER, eyeControlPoints, samplePortrait } from './portraitTimeline';

const VERTEX = `attribute vec2 position; varying vec2 screen;
void main(){ screen=vec2(position.x*.5+.5,.5-position.y*.5); gl_Position=vec4(position,0.,1.); }`;
const FRAGMENT = `precision highp float;
varying vec2 screen;
uniform sampler2D awake;
uniform sampler2D asleep;
uniform vec2 viewport;
uniform float opening;
uniform float material;
uniform vec4 upperLid;
uniform vec4 lowerLid;
uniform vec4 closedLid;
uniform vec4 openLid;
const vec4 eyeX=vec4(${EYE_X.map(value => value.toFixed(1)).join(',')});
float cubic(float a,float b,float c,float d,float t){float s=1.-t;return s*s*s*a+3.*s*s*t*b+3.*s*t*t*c+t*t*t*d;}
void main(){
 vec2 size=vec2(1672.,941.); float scale=max(viewport.x/size.x,viewport.y/size.y);
 vec2 offset=vec2(viewport.x-size.x*scale,(viewport.y-size.y*scale)*.5);
 vec2 p=(screen*viewport-offset)/scale; vec2 uv=p/size;
 vec3 color=texture2D(awake,uv).rgb;
 if(p.x>1200. && p.x<1630. && p.y>310. && p.y<620. && opening<.9999){
   float t=clamp((p.x-1260.)/307.,0.,1.);
   for(int j=0;j<4;j++){
     float s=1.-t;
     float dx=3.*s*s*70.+6.*s*t*155.+3.*t*t*82.;
     t=clamp(t-(cubic(eyeX.x,eyeX.y,eyeX.z,eyeX.w,t)-p.x)/dx,0.,1.);
   }
   float closed=cubic(closedLid.x,closedLid.y,closedLid.z,closedLid.w,t);
   float top=cubic(upperLid.x,upperLid.y,upperLid.z,upperLid.w,t);
   float bottom=cubic(lowerLid.x,lowerLid.y,lowerLid.z,lowerLid.w,t);
   bool inside=p.x>1260. && p.x<1567. && p.y>top && p.y<bottom;
   if(!inside){
     float sourceY=p.y<top ? 310.+(p.y-310.)*(closed-7.-310.)/max(1.,top-310.)
       : 620.-(620.-p.y)*(620.-closed-32.)/max(1.,620.-bottom);
     vec3 skin=texture2D(asleep,vec2(p.x,sourceY)/size).rgb;
     float feather=smoothstep(1200.,1245.,p.x)*(1.-smoothstep(1585.,1630.,p.x))
       *smoothstep(310.,345.,p.y)*(1.-smoothstep(575.,620.,p.y));
     color=mix(color,skin,feather*(1.-smoothstep(.96,1.,opening)));
   }
   // The lash root follows the *moving* lid boundary. The iris remains stationary.
   if(p.x>1258. && p.x<1570.){
     float root=1.-smoothstep(1.3,3.1,abs(p.y-top));
     float dy=p.y-top;
     float lashes=0.;
     float foreshorten=1.-2.*opening;
     // Preserve the painted lash clusters while rotating/foreshortening the lid.
     // Only the small lash strip is sampled; no closed-eye photograph overlays the iris.
     if(foreshorten>.025 && dy>0. && dy<34.*foreshorten){
       vec3 lash=texture2D(asleep,vec2(p.x,closed+dy/foreshorten)/size).rgb;
       lashes=1.-smoothstep(.028,.11,dot(lash,vec3(.299,.587,.114)));
     }
     float lift=smoothstep(.48,.88,opening);
     if(lift>0. && dy<0. && dy> -42.*lift){
       float openTop=cubic(openLid.x,openLid.y,openLid.z,openLid.w,t);
       vec3 lash=texture2D(awake,vec2(p.x,openTop+dy/max(.1,lift))/size).rgb;
       lashes=max(lashes,1.-smoothstep(.028,.11,dot(lash,vec3(.299,.587,.114))));
     }
     float ink=max(root,lashes)*(1.-smoothstep(.90,1.,opening));
     color=mix(color,vec3(.012,.016,.025),ink);
   }
 }
 // Spatial material scan travels across the portrait; no whole-image dissolve.
 float front=material*1.20-.10;
 float exposure=1.-smoothstep(front-.045,front+.045,uv.y);
 float scan=exp(-pow((uv.y-front)*100.,2.))*.30;
 color+=vec3(.10,.46,.65)*scan;
 gl_FragColor=vec4(color,exposure*.82);
}`;

let imagesPromise: Promise<HTMLImageElement[]> | undefined;
export function loadPortraitImages() {
  return imagesPromise ??= Promise.all(['companion.webp', 'companion-sleep.webp'].map(file => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => { void image.decode().then(() => resolve(image), reject); };
    image.onerror = reject;
    image.src = `/media/entry/${file}`;
  }))).catch(error => { imagesPromise = undefined; throw error; });
}

export function createPortraitRenderer(canvas: HTMLCanvasElement, images: HTMLImageElement[]) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, depth: false });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  const textures: WebGLTexture[] = [];
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const dispose = () => {
    textures.forEach(texture => gl.deleteTexture(texture));
    shaders.forEach(shader => gl.deleteShader(shader));
    gl.deleteBuffer(buffer); gl.deleteProgram(program);
  };
  if (!program || !buffer) { dispose(); return null; }
  for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(kind);
    if (!shader) { dispose(); return null; }
    shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { dispose(); return null; }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { dispose(); return null; }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  images.forEach((image, index) => {
    const texture = gl.createTexture();
    if (!texture) return;
    textures.push(texture); gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.uniform1i(gl.getUniformLocation(program, index ? 'asleep' : 'awake'), index);
  });
  if (textures.length !== 2) { dispose(); return null; }
  const viewport = gl.getUniformLocation(program, 'viewport');
  const opening = gl.getUniformLocation(program, 'opening');
  const material = gl.getUniformLocation(program, 'material');
  const upperLid = gl.getUniformLocation(program, 'upperLid');
  const lowerLid = gl.getUniformLocation(program, 'lowerLid');
  gl.uniform4f(gl.getUniformLocation(program, 'closedLid'), ...CLOSED_LID);
  gl.uniform4f(gl.getUniformLocation(program, 'openLid'), ...OPEN_UPPER);
  return {
    draw(time: number) {
      const bounds = { width: canvas.clientWidth, height: canvas.clientHeight };
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      const state = samplePortrait(time);
      gl.uniform2f(viewport, bounds.width, bounds.height);
      const lid = eyeControlPoints(state.eye);
      gl.uniform4f(upperLid, ...lid.upper); gl.uniform4f(lowerLid, ...lid.lower);
      gl.uniform1f(opening, state.eye); gl.uniform1f(material, state.material);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose,
  };
}
