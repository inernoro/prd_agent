"""Cloud-only image-led authoring: generated artwork supplies the actual geometry."""
import os
if os.environ.get('CI') != 'true':
    raise SystemExit('Cloud CI only: do not render on the user computer.')
from pathlib import Path
import hashlib, json, math, subprocess
import cv2
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / '.design/map-cinematic-entry/ai-v2'
OUT = ROOT / 'work/entry-portrait'
OUT.mkdir(parents=True, exist_ok=True)
cv2.setNumThreads(2)
FPS, COUNT = 60, 310

def read(path):
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    assert image is not None, f'Cannot read {path}'
    return image

closed = read(ROOT / 'llmgw/web/public/media/entry/companion-sleep.webp')
opened = read(ROOT / 'llmgw/web/public/media/entry/companion.webp')
H, W = closed.shape[:2]
EH = H + H % 2
assert opened.shape == closed.shape
proof = {'method': 'generated-keyframes-opencv-strokes-optical-flow', 'fps': FPS,
         'sourceFrames': COUNT, 'sourceSize': [W,H], 'encodedSize': [W,EH],
         'registration': {}, 'sources': {}}

def register(image, name):
    """Conservative registration against stable hair/bow anchors, excluding the eye."""
    if image.shape != closed.shape:
        image = cv2.resize(image, (W,H), interpolation=cv2.INTER_LANCZOS4)
    sift = cv2.SIFT_create(nfeatures=4000)
    a, da = sift.detectAndCompute(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), None)
    b, db = sift.detectAndCompute(cv2.cvtColor(closed, cv2.COLOR_BGR2GRAY), None)
    pairs = [] if da is None or db is None else cv2.BFMatcher().knnMatch(da,db,k=2)
    good = [m for pair in pairs if len(pair)==2 for m,n in [pair] if m.distance < .72*n.distance]
    matrix, count = None, 0
    if len(good) >= 12:
        src = np.float32([a[m.queryIdx].pt for m in good]); dst = np.float32([b[m.trainIdx].pt for m in good])
        stable = (src[:,0] < W*.74) | (src[:,1] < H*.27) | (src[:,1] > H*.69)
        if np.count_nonzero(stable) >= 12:
            candidate, inliers = cv2.estimateAffinePartial2D(src[stable],dst[stable],method=cv2.RANSAC,ransacReprojThreshold=3,maxIters=3000)
            if candidate is not None:
                scale = math.hypot(candidate[0,0],candidate[1,0]); angle = math.degrees(math.atan2(candidate[1,0],candidate[0,0]))
                count = int(np.count_nonzero(inliers))
                if count >= 10 and .97 < scale < 1.03 and abs(angle) < 1.5 and np.max(np.abs(candidate[:,2])) < 30:
                    matrix = candidate
    if matrix is not None:
        image = cv2.warpAffine(image,matrix,(W,H),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_CONSTANT)
    proof['registration'][name] = {'matches':len(good),'inliers':count,'accepted':matrix is not None,
                                   'matrix':None if matrix is None else matrix.tolist()}
    cv2.imwrite(str(OUT/f'registered-{name}.jpg'),image)
    return image

art = {}
for name in ['line-etching','surface-reveal','eye-quarter','eye-half','eye-three-quarter']:
    path = INPUT/f'{name}.png'
    proof['sources'][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    art[name] = register(read(path),name)
for name in ['companion-sleep.webp','companion.webp']:
    path = ROOT/'llmgw/web/public/media/entry'/name
    proof['sources'][name] = hashlib.sha256(path.read_bytes()).hexdigest()

# Follow actual generated curves, remove isolated noise, and skeletonize.
# This does not invent substitute hair paths or a regular planar facial grid.
line = art['line-etching']
binary = np.uint8(np.max(line,axis=2)>34)*255
n, labels, stats, _ = cv2.connectedComponentsWithStats(binary,8)
clean = np.zeros_like(binary)
for label in range(1,n):
    if stats[label,cv2.CC_STAT_AREA] >= 9: clean[labels==label] = 255
skeleton = cv2.ximgproc.thinning(clean)
contours,_ = cv2.findContours(skeleton,cv2.RETR_LIST,cv2.CHAIN_APPROX_NONE)
rng = np.random.default_rng(20261118)
strokes = []
for contour in contours:
    points = contour[:,0,:]
    if len(points)<10: continue
    for offset in range(0,len(points)-6,180):
        p = points[offset:offset+185]
        if len(p)<8: continue
        p = cv2.approxPolyDP(p.reshape(-1,1,2),.35,False)[:,0,:]
        if len(p)<3: continue
        lengths = np.r_[0,np.cumsum(np.linalg.norm(np.diff(p,axis=0),axis=1))]
        if lengths[-1]<12: continue
        center = np.mean(p,axis=0)
        start = .22+1.15*(.65*center[1]/H+.35*rng.random())
        if center[0]>W*.76 and .31<center[1]/H<.65: start += .22
        strokes.append({'points':p,'lengths':lengths,'start':start,
                        'duration':.16+min(.53,lengths[-1]/450),'drawn':0})
assert len(strokes)>150, f'Insufficient authored linework: {len(strokes)}'
proof['strokes'] = {'count':len(strokes),'skeletonPixels':int(np.count_nonzero(skeleton)),
                    'source':'generated line-etching.png','uniformVectorSubstitute':False}
cv2.imwrite(str(OUT/'line-skeleton.png'),skeleton)

def smooth(a,b,value):
    x = np.clip((value-a)/(b-a),0,1)
    return x*x*(3-2*x)

# Derive an eye ROI from real endpoint differences. All other pixels stay original.
delta = cv2.cvtColor(cv2.absdiff(closed,opened),cv2.COLOR_BGR2GRAY)
hint = np.zeros((H,W),np.uint8); hint[int(.28*H):int(.66*H),int(.73*W):]=255
changed = np.uint8((delta>16)&(hint>0))*255
changed = cv2.morphologyEx(changed,cv2.MORPH_CLOSE,np.ones((13,13),np.uint8))
parts,_ = cv2.findContours(changed,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
assert parts, 'No eye difference in endpoint artwork'
x,y,w,h = cv2.boundingRect(max(parts,key=cv2.contourArea))
x0,y0,x1,y1 = max(0,x-34),max(0,y-34),min(W,x+w+34),min(H,y+h+34)
assert w>90 and h>30, f'Unexpected eye aperture {(x,y,w,h)}'
proof['eyeRegion'] = [x0,y0,x1,y1]
eye_mask = np.zeros((H,W),np.float32); eye_mask[y0+8:y1-8,x0+8:x1-8]=1
eye_mask = cv2.GaussianBlur(eye_mask,(41,41),0)[y0:y1,x0:x1,None]
eyes = [closed]+[art[n] for n in ['eye-quarter','eye-half','eye-three-quarter']]+[opened]
crops = [im[y0:y1,x0:x1].astype(np.float32) for im in eyes]
flows = []
dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
for a,b in zip(crops,crops[1:]):
    ga,gb = [cv2.cvtColor(np.uint8(im),cv2.COLOR_BGR2GRAY) for im in (a,b)]
    ab,ba = dis.calc(ga,gb,None),dis.calc(gb,ga,None)
    flows.append((cv2.GaussianBlur(ab,(5,5),0),cv2.GaussianBlur(ba,(5,5),0)))
gy,gx = np.mgrid[0:y1-y0,0:x1-x0].astype(np.float32)

def full_color(t):
    if t>=3.80: return opened.astype(np.float32)
    if t<=2.70: return closed.astype(np.float32)
    progress = float(smooth(2.70,3.80,t))*4; segment = min(3,int(progress)); u = min(1.,progress-segment)
    ab,ba = flows[segment]
    a = cv2.remap(crops[segment],gx-u*ab[:,:,0],gy-u*ab[:,:,1],cv2.INTER_CUBIC,borderMode=cv2.BORDER_REFLECT101)
    b = cv2.remap(crops[segment+1],gx-(1-u)*ba[:,:,0],gy-(1-u)*ba[:,:,1],cv2.INTER_CUBIC,borderMode=cv2.BORDER_REFLECT101)
    result = closed.astype(np.float32).copy()
    result[y0:y1,x0:x1] = result[y0:y1,x0:x1]*(1-eye_mask)+(a*(1-u)+b*u)*eye_mask
    return result

proof['eyeKeyframes'] = ['closed','quarter','half','three-quarter','open']
proof['eyeMethod'] = 'registered generated poses with bidirectional dense optical flow; opaque eyelid anatomy'
for i,crop in enumerate(crops): cv2.imwrite(str(OUT/f'eye-key-{i}.jpg'),np.uint8(crop))

# Smooth spatial material revelation, avoiding a straight screen-wide curtain.
noise = cv2.resize(rng.random((15,25),dtype=np.float32),(W,H),interpolation=cv2.INTER_CUBIC)
noise = cv2.GaussianBlur(noise,(61,61),0); noise = (noise-noise.min())/max(1e-6,noise.max()-noise.min())
xx,yy = np.meshgrid(np.linspace(0,1,W),np.linspace(0,1,H))
field = (.42*noise+.33*yy+.25*(1-xx)).astype(np.float32)
mask = np.zeros((H,W),np.uint8)
line_float = line.astype(np.float32); surface = art['surface-reveal'].astype(np.float32)
movie = OUT/'portrait-motion.mp4'
encoder = subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','bgr24',
    '-video_size',f'{W}x{EH}','-framerate',str(FPS),'-i','-','-an','-c:v','libx264','-preset','medium','-crf','18',
    '-pix_fmt','yuv420p','-threads','2','-movflags','+faststart',str(movie)],stdin=subprocess.PIPE)
samples = []
try:
    for frame in range(COUNT):
        t = frame/FPS
        for stroke in strokes:
            p = float(smooth(stroke['start'],stroke['start']+stroke['duration'],t))
            end = min(len(stroke['points']),int(np.searchsorted(stroke['lengths'],p*stroke['lengths'][-1],side='right')))
            if end>max(1,stroke['drawn']):
                a = max(0,stroke['drawn']-1)
                cv2.polylines(mask,[stroke['points'][a:end].reshape(-1,1,2)],False,255,3,cv2.LINE_AA)
                stroke['drawn']=end
        ink = np.maximum(mask.astype(np.float32)/255,smooth(1.28,1.85,t)*.92)
        drawing = line_float*ink[:,:,None]
        grid = smooth(1.38,1.95,t)*(1-smooth(2.18,2.61,t))
        drawing = drawing*(1-grid)+surface*grid
        exposure = smooth(1.94,2.70,t)
        reveal = smooth(0,.22,exposure-field*.56)
        if t>=2.70: reveal = np.ones((H,W),np.float32)
        output = drawing*(1-reveal[:,:,None])+full_color(t)*reveal[:,:,None]
        output = np.uint8(np.clip(output*smooth(.06,.35,t),0,255))
        if frame>=228: assert np.mean(cv2.absdiff(output,opened))<1., 'Final frame differs from actual full-color endpoint'
        if EH!=H: output = cv2.copyMakeBorder(output,0,EH-H,0,0,cv2.BORDER_REPLICATE)
        encoder.stdin.write(output.tobytes())
        if frame%15==0:
            cv2.imwrite(str(OUT/f'preview-{frame:03}.jpg'),output,[cv2.IMWRITE_JPEG_QUALITY,94])
            eye = output[y0:y1,x0:x1]; cv2.imwrite(str(OUT/f'eye-frame-{frame:03}.jpg'),eye)
            samples.append({'time':round(t,3),'mean':float(np.mean(output)),'eyeMean':float(np.mean(eye)),'grid':float(grid)})
        if frame%FPS==0: print(f'Rendered asset frame {frame}/{COUNT}',flush=True)
finally:
    encoder.stdin.close()
assert encoder.wait()==0, 'Cloud encoding failed'
proof['samples']=samples; proof['sha256']=hashlib.sha256(movie.read_bytes()).hexdigest()
proof['fileName']=f"portrait-motion-{proof['sha256'][:12]}.mp4"
probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-select_streams','v:0',
    '-show_entries','stream=width,height,nb_read_frames,r_frame_rate','-of','json',str(movie)]))['streams'][0]
assert int(probe['nb_read_frames'])==COUNT and probe['r_frame_rate']=='60/1'
proof['encoded']=probe
(OUT/'composition-proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
thumbs=[]
for frame in range(0,COUNT,15):
    im = cv2.resize(read(OUT/f'preview-{frame:03}.jpg'),(640,360),interpolation=cv2.INTER_AREA)
    cv2.putText(im,f'{frame/FPS:.2f}s',(12,26),cv2.FONT_HERSHEY_SIMPLEX,.65,(220,230,240),1,cv2.LINE_AA); thumbs.append(im)
for start in range(0,len(thumbs),6):
    sheet=np.zeros((1080,1280,3),np.uint8)
    for j,im in enumerate(thumbs[start:start+6]): sheet[j//2*360:(j//2+1)*360,j%2*640:(j%2+1)*640]=im
    cv2.imwrite(str(OUT/f'contact-{start//6:02}.jpg'),sheet)
print(json.dumps({'file':proof['fileName'],'strokes':len(strokes),'eyeRegion':proof['eyeRegion'],'encoded':probe}),flush=True)
