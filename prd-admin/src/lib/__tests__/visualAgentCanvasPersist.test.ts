/**
 * VisualAgent Canvas 持久化测试
 *
 * 关键测试场景：
 * 1. running 状态的占位元素必须被保存
 * 2. running 状态的占位元素必须能被正确恢复
 * 3. 后端回填时能通过 id 字段找到元素
 *
 * 运行方式：pnpm -C prd-admin test visualAgentCanvasPersist
 */

import { describe, it, expect } from 'vitest';
import {
  canvasToPersistedV1,
  persistedV1ToCanvas,
  isRemoteImageSrc,
  type CanvasImageItem,
  type PersistedCanvasStateV1,
  type ImageAsset,
} from '../visualAgentCanvasPersist';

describe('VisualAgent Canvas 持久化测试', () => {
  
  describe('isRemoteImageSrc', () => {
    it('应识别远程 URL', () => {
      expect(isRemoteImageSrc('https://example.com/image.png')).toBe(true);
      expect(isRemoteImageSrc('http://example.com/image.png')).toBe(true);
      expect(isRemoteImageSrc('/api/visual-agent/image-master/assets/file/abc.png')).toBe(true);
    });

    it('应拒绝本地/无效 URL', () => {
      expect(isRemoteImageSrc('')).toBe(false);
      expect(isRemoteImageSrc('data:image/png;base64,xxx')).toBe(false);
      expect(isRemoteImageSrc('blob:http://localhost/xxx')).toBe(false);
    });
  });

  describe('canvasToPersistedV1 - 核心保存逻辑', () => {
    
    it('应保存完成状态的图片（有 assetId）', () => {
      const items: CanvasImageItem[] = [{
        key: 'img-1',
        createdAt: Date.now(),
        prompt: 'test prompt',
        src: 'https://example.com/image.png',
        status: 'done',
        kind: 'image',
        assetId: 'asset-123',
        x: 100,
        y: 200,
        w: 1024,
        h: 1024,
      }];

      const result = canvasToPersistedV1(items);
      
      expect(result.state.elements.length).toBe(1);
      expect(result.state.elements[0].id).toBe('img-1');
      expect(result.skippedLocalOnlyImages).toBe(0);
    });

    it('应往返保存 AI 分层 Frame 元数据', () => {
      const items: CanvasImageItem[] = [{
        key: 'layer-1',
        createdAt: Date.now(),
        prompt: 'AI 图层 01',
        src: 'https://example.com/layer-1.png',
        status: 'done',
        kind: 'image',
        assetId: 'asset-layer-1',
        layerGroupId: 'group-1',
        layerSourceKey: 'source-1',
        layerIndex: 1,
        layerRole: 'layer',
      }];

      const persisted = canvasToPersistedV1(items);
      const restored = persistedV1ToCanvas(persisted.state, [{
        id: 'asset-layer-1',
        url: 'https://example.com/layer-1.png',
      }]);

      expect(restored.canvas[0]).toMatchObject({
        layerGroupId: 'group-1',
        layerSourceKey: 'source-1',
        layerIndex: 1,
        layerRole: 'layer',
      });
    });

    it('【关键】图层的排版尺寸标记必须往返，否则刷新后 Frame 会塌', () => {
      // 实测缺陷（2026-08-10 用户截图）：刷新后同一个 Frame 里等大对齐的图层
      // 塌成大小不一的碎块。根因是 userResized 没落盘，恢复后 img.onLoad
      // 拿 natural 尺寸把排版算好的 w/h 覆盖掉了。
      const items: CanvasImageItem[] = [{
        key: 'layer-1',
        createdAt: Date.now(),
        prompt: '图层 01',
        src: 'https://example.com/layer-1.png',
        status: 'done',
        kind: 'image',
        assetId: 'asset-layer-1',
        x: 10, y: 20, w: 300, h: 300,
        naturalW: 640, naturalH: 640,
        userResized: true,
        layerGroupId: 'group-1',
        layerRole: 'layer',
        layerHidden: true,
        layerOpacity: 0.5,
        layerZ: 3,
        layerContentKind: 'flat',
        layerCoverage: 0.9876,
      }];

      const restored = persistedV1ToCanvas(canvasToPersistedV1(items).state, [{
        id: 'asset-layer-1',
        url: 'https://example.com/layer-1.png',
        width: 640,
        height: 640,
      }]);

      expect(restored.canvas[0]).toMatchObject({
        w: 300,
        h: 300,
        userResized: true,
        layerHidden: true,
        layerOpacity: 0.5,
        layerZ: 3,
        layerContentKind: 'flat',
        layerCoverage: 0.9876,
      });
    });

    it('【关键】用户手动拉过尺寸的普通图片，刷新后不许被 natural 尺寸打回原形', () => {
      // 这一条才真正盯住「userResized 有没有落盘」：分层图层那条有 layerRole 兜底，
      // 就算不落盘也能恢复，测不出写入端漏字段。普通图片没有兜底，漏了立刻现形。
      const items: CanvasImageItem[] = [{
        key: 'img-1',
        createdAt: Date.now(),
        prompt: '一张被拉小的图',
        src: 'https://example.com/a.png',
        status: 'done',
        kind: 'image',
        assetId: 'asset-a',
        w: 200, h: 200,
        naturalW: 1024, naturalH: 1024,
        userResized: true,
      }];
      const restored = persistedV1ToCanvas(canvasToPersistedV1(items).state, [{
        id: 'asset-a', url: 'https://example.com/a.png', width: 1024, height: 1024,
      }]);
      expect(restored.canvas[0]).toMatchObject({ w: 200, h: 200, userResized: true });
    });

    it('存量分层数据没有 userResized，但只要存过尺寸就照样锁住排版', () => {
      const legacy = {
        schemaVersion: 1 as const,
        elements: [{
          id: 'layer-1',
          kind: 'image' as const,
          x: 0, y: 0, w: 300, h: 300,
          assetId: 'asset-layer-1',
          ext: { layerGroupId: 'g', layerRole: 'layer' },
        }],
      };
      const restored = persistedV1ToCanvas(legacy, [{ id: 'asset-layer-1', url: 'u', width: 640, height: 640 }]);
      expect(restored.canvas[0]).toMatchObject({ w: 300, h: 300, userResized: true });
    });

    it('没存过尺寸的分层元素不许锁住排版，否则卡片会渲染成 0', () => {
      const legacy = {
        schemaVersion: 1 as const,
        elements: [{
          id: 'layer-1',
          kind: 'image' as const,
          assetId: 'asset-layer-1',
          ext: { layerGroupId: 'g', layerRole: 'layer' },
        }],
      };
      const restored = persistedV1ToCanvas(legacy, [{ id: 'asset-layer-1', url: 'u' }]);
      expect(restored.canvas[0]!.userResized).toBe(false);
    });

    it('应保存完成状态的图片（有远程 src 无 assetId）', () => {
      const items: CanvasImageItem[] = [{
        key: 'img-2',
        createdAt: Date.now(),
        prompt: 'test prompt',
        src: 'https://example.com/image.png',
        status: 'done',
        kind: 'image',
        x: 100,
        y: 200,
        w: 1024,
        h: 1024,
      }];

      const result = canvasToPersistedV1(items);
      
      expect(result.state.elements.length).toBe(1);
      expect(result.state.elements[0].id).toBe('img-2');
    });

    it('【关键】应保存 running 状态的占位元素', () => {
      const items: CanvasImageItem[] = [{
        key: 'gen_123456',
        createdAt: Date.now(),
        prompt: '生成一张可爱的猫咪图片',
        src: '', // 还没有图片
        status: 'running', // 生成中
        kind: 'image',
        x: 100,
        y: 200,
        w: 1024,
        h: 1024,
      }];

      const result = canvasToPersistedV1(items);
      
      expect(result.state.elements.length).toBe(1);
      expect(result.state.elements[0].id).toBe('gen_123456');
      expect(result.state.elements[0].kind).toBe('image');
      expect((result.state.elements[0] as any).status).toBe('running');
      expect(result.skippedLocalOnlyImages).toBe(0);
    });

    it('【关键】应保存 error 状态的占位元素', () => {
      const items: CanvasImageItem[] = [{
        key: 'gen_failed',
        createdAt: Date.now(),
        prompt: '失败的生成请求',
        src: '',
        status: 'error',
        kind: 'image',
        x: 100,
        y: 200,
        w: 1024,
        h: 1024,
      }];

      const result = canvasToPersistedV1(items);
      
      expect(result.state.elements.length).toBe(1);
      expect(result.state.elements[0].id).toBe('gen_failed');
      expect((result.state.elements[0] as any).status).toBe('error');
    });

    it('应跳过 data: URL 的本地图片（done 状态）', () => {
      const items: CanvasImageItem[] = [{
        key: 'local-img',
        createdAt: Date.now(),
        prompt: 'local image',
        src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        status: 'done',
        kind: 'image',
        x: 100,
        y: 200,
        w: 100,
        h: 100,
      }];

      const result = canvasToPersistedV1(items);
      
      expect(result.state.elements.length).toBe(0);
      expect(result.skippedLocalOnlyImages).toBe(1);
    });

    it('应保存 generator 类型元素', () => {
      const items: CanvasImageItem[] = [{
        key: 'generator-1',
        createdAt: Date.now(),
        prompt: 'Image Generator',
        src: '',
        status: 'done',
        kind: 'generator',
        x: 0,
        y: 0,
        w: 1024,
        h: 1024,
      }];

      const result = canvasToPersistedV1(items);
      
      expect(result.state.elements.length).toBe(1);
      expect(result.state.elements[0].kind).toBe('generator');
    });

    it('应保存 shape 类型元素', () => {
      const items: CanvasImageItem[] = [{
        key: 'shape-1',
        createdAt: Date.now(),
        prompt: '',
        src: '',
        status: 'done',
        kind: 'shape',
        shapeType: 'rect',
        fill: '#ffffff',
        stroke: '#000000',
        x: 50,
        y: 50,
        w: 200,
        h: 100,
      }];

      const result = canvasToPersistedV1(items);
      
      expect(result.state.elements.length).toBe(1);
      expect(result.state.elements[0].kind).toBe('shape');
    });

    it('应保存 text 类型元素', () => {
      const items: CanvasImageItem[] = [{
        key: 'text-1',
        createdAt: Date.now(),
        prompt: '',
        src: '',
        status: 'done',
        kind: 'text',
        text: 'Hello World',
        fontSize: 24,
        textColor: '#000000',
        x: 100,
        y: 100,
        w: 200,
        h: 50,
      }];

      const result = canvasToPersistedV1(items);
      
      expect(result.state.elements.length).toBe(1);
      expect(result.state.elements[0].kind).toBe('text');
    });

    it('应正确处理混合元素', () => {
      const items: CanvasImageItem[] = [
        {
          key: 'done-img',
          createdAt: Date.now(),
          prompt: 'done',
          src: 'https://example.com/1.png',
          status: 'done',
          kind: 'image',
          assetId: 'asset-1',
          x: 0, y: 0, w: 100, h: 100,
        },
        {
          key: 'running-placeholder',
          createdAt: Date.now(),
          prompt: 'running',
          src: '',
          status: 'running',
          kind: 'image',
          x: 200, y: 0, w: 1024, h: 1024,
        },
        {
          key: 'local-only',
          createdAt: Date.now(),
          prompt: 'local',
          src: 'data:image/png;base64,xxx',
          status: 'done',
          kind: 'image',
          x: 400, y: 0, w: 100, h: 100,
        },
      ];

      const result = canvasToPersistedV1(items);
      
      // done-img 和 running-placeholder 应该被保存
      expect(result.state.elements.length).toBe(2);
      expect(result.state.elements.find(e => e.id === 'done-img')).toBeDefined();
      expect(result.state.elements.find(e => e.id === 'running-placeholder')).toBeDefined();
      expect(result.state.elements.find(e => e.id === 'local-only')).toBeUndefined();
      expect(result.skippedLocalOnlyImages).toBe(1);
    });
  });

  describe('persistedV1ToCanvas - 核心恢复逻辑', () => {
    
    it('应恢复完成状态的图片（从 assets 获取 URL）', () => {
      const state: PersistedCanvasStateV1 = {
        schemaVersion: 1,
        elements: [{
          id: 'img-1',
          kind: 'image',
          assetId: 'asset-123',
          x: 100,
          y: 200,
          w: 1024,
          h: 1024,
        }],
      };
      
      const assets: ImageAsset[] = [{
        id: 'asset-123',
        url: 'https://example.com/image.png',
        sha256: 'abc123',
        prompt: 'test prompt',
        width: 1024,
        height: 1024,
      }];

      const result = persistedV1ToCanvas(state, assets);
      
      expect(result.canvas.length).toBe(1);
      expect(result.canvas[0].key).toBe('img-1');
      expect(result.canvas[0].src).toBe('https://example.com/image.png');
      expect(result.canvas[0].status).toBe('done');
      expect(result.missingAssets).toBe(0);
    });

    it('【关键】应恢复 running 状态的占位元素', () => {
      const state: PersistedCanvasStateV1 = {
        schemaVersion: 1,
        elements: [{
          id: 'gen_123456',
          kind: 'image',
          name: '生成一张可爱的猫咪图片',
          status: 'running',
          x: 100,
          y: 200,
          w: 1024,
          h: 1024,
        }],
      };

      const result = persistedV1ToCanvas(state, []);
      
      expect(result.canvas.length).toBe(1);
      expect(result.canvas[0].key).toBe('gen_123456');
      expect(result.canvas[0].status).toBe('running');
      expect(result.canvas[0].src).toBe('');
      expect(result.canvas[0].prompt).toBe('生成一张可爱的猫咪图片');
      expect(result.missingAssets).toBe(0);
      expect(result.localOnlyImages).toBe(0);
    });

    it('【关键】应恢复 error 状态的占位元素', () => {
      const state: PersistedCanvasStateV1 = {
        schemaVersion: 1,
        elements: [{
          id: 'gen_failed',
          kind: 'image',
          name: '失败的生成请求',
          status: 'error',
          x: 100,
          y: 200,
          w: 1024,
          h: 1024,
        }],
      };

      const result = persistedV1ToCanvas(state, []);
      
      expect(result.canvas.length).toBe(1);
      expect(result.canvas[0].key).toBe('gen_failed');
      expect(result.canvas[0].status).toBe('error');
    });

    it('应跳过无效的图片元素（无 src 无 status）', () => {
      const state: PersistedCanvasStateV1 = {
        schemaVersion: 1,
        elements: [{
          id: 'invalid-img',
          kind: 'image',
          x: 100,
          y: 200,
          w: 100,
          h: 100,
        }],
      };

      const result = persistedV1ToCanvas(state, []);
      
      expect(result.canvas.length).toBe(0);
      // 无 assetId 无 src 的元素计入 localOnlyImages
      expect(result.localOnlyImages).toBe(1);
    });

    it('应恢复 generator 类型元素', () => {
      const state: PersistedCanvasStateV1 = {
        schemaVersion: 1,
        elements: [{
          id: 'generator-1',
          kind: 'generator',
          prompt: 'Image Generator',
          x: 0,
          y: 0,
          w: 1024,
          h: 1024,
        }],
      };

      const result = persistedV1ToCanvas(state, []);
      
      expect(result.canvas.length).toBe(1);
      expect(result.canvas[0].kind).toBe('generator');
      expect(result.canvas[0].status).toBe('done');
    });
  });

  describe('保存-恢复 往返测试', () => {
    
    it('running 状态的占位元素应能完整往返', () => {
      const originalItems: CanvasImageItem[] = [{
        key: 'gen_roundtrip',
        createdAt: Date.now(),
        prompt: '往返测试',
        src: '',
        status: 'running',
        kind: 'image',
        x: 100,
        y: 200,
        w: 1024,
        h: 1024,
      }];

      // 保存
      const persisted = canvasToPersistedV1(originalItems);
      expect(persisted.state.elements.length).toBe(1);
      
      // 恢复
      const restored = persistedV1ToCanvas(persisted.state, []);
      expect(restored.canvas.length).toBe(1);
      
      // 验证
      const item = restored.canvas[0];
      expect(item.key).toBe('gen_roundtrip');
      expect(item.status).toBe('running');
      expect(item.prompt).toBe('往返测试');
      expect(item.x).toBe(100);
      expect(item.y).toBe(200);
      expect(item.w).toBe(1024);
      expect(item.h).toBe(1024);
    });

    it('完成状态的图片应能完整往返', () => {
      const originalItems: CanvasImageItem[] = [{
        key: 'done_roundtrip',
        createdAt: Date.now(),
        prompt: '完成的图片',
        src: 'https://example.com/image.png',
        status: 'done',
        kind: 'image',
        assetId: 'asset-123',
        sha256: 'sha256hash',
        x: 50,
        y: 100,
        w: 800,
        h: 600,
        naturalW: 800,
        naturalH: 600,
      }];

      const assets: ImageAsset[] = [{
        id: 'asset-123',
        url: 'https://example.com/image.png',
        sha256: 'sha256hash',
        prompt: '完成的图片',
      }];

      // 保存
      const persisted = canvasToPersistedV1(originalItems);
      expect(persisted.state.elements.length).toBe(1);
      
      // 恢复
      const restored = persistedV1ToCanvas(persisted.state, assets);
      expect(restored.canvas.length).toBe(1);
      
      // 验证
      const item = restored.canvas[0];
      expect(item.key).toBe('done_roundtrip');
      expect(item.status).toBe('done');
      expect(item.src).toBe('https://example.com/image.png');
    });

    it('混合元素应能完整往返', () => {
      const originalItems: CanvasImageItem[] = [
        {
          key: 'running-1',
          createdAt: Date.now(),
          prompt: 'running',
          src: '',
          status: 'running',
          kind: 'image',
          x: 0, y: 0, w: 1024, h: 1024,
        },
        {
          key: 'generator-1',
          createdAt: Date.now(),
          prompt: 'generator',
          src: '',
          status: 'done',
          kind: 'generator',
          x: 1100, y: 0, w: 1024, h: 1024,
        },
        {
          key: 'shape-1',
          createdAt: Date.now(),
          prompt: '',
          src: '',
          status: 'done',
          kind: 'shape',
          shapeType: 'rect',
          x: 2200, y: 0, w: 200, h: 100,
        },
      ];

      // 保存
      const persisted = canvasToPersistedV1(originalItems);
      expect(persisted.state.elements.length).toBe(3);
      
      // 恢复
      const restored = persistedV1ToCanvas(persisted.state, []);
      expect(restored.canvas.length).toBe(3);
      
      // 验证各元素
      expect(restored.canvas.find(e => e.key === 'running-1')?.status).toBe('running');
      expect(restored.canvas.find(e => e.key === 'generator-1')?.kind).toBe('generator');
      expect(restored.canvas.find(e => e.key === 'shape-1')?.kind).toBe('shape');
    });
  });

  describe('后端回填场景模拟', () => {
    
    it('模拟：用户点击生成 -> 保存 -> 后端回填 -> 用户刷新恢复', () => {
      // 步骤1：用户点击生成，创建 running 占位
      const step1_items: CanvasImageItem[] = [{
        key: 'gen_backend_test',
        createdAt: Date.now(),
        prompt: '后端回填测试',
        src: '',
        status: 'running',
        kind: 'image',
        x: 100,
        y: 200,
        w: 1024,
        h: 1024,
      }];

      // 步骤2：保存到后端
      const step2_persisted = canvasToPersistedV1(step1_items);
      expect(step2_persisted.state.elements.length).toBe(1);
      expect(step2_persisted.state.elements[0].id).toBe('gen_backend_test');
      
      // 步骤3：模拟后端回填（修改 JSON）
      const jsonString = JSON.stringify(step2_persisted.state);
      const jsonObj = JSON.parse(jsonString);
      
      // 后端通过 id 字段找到元素
      const targetElement = jsonObj.elements.find((e: any) => e.id === 'gen_backend_test');
      expect(targetElement).toBeDefined();
      
      // 后端修改元素状态
      targetElement.status = 'done';
      targetElement.src = 'https://cdn.example.com/generated-image.png';
      targetElement.assetId = 'new-asset-id';
      targetElement.sha256 = 'new-sha256';
      
      // 步骤4：用户刷新，恢复画布
      const step4_restored = persistedV1ToCanvas(jsonObj as PersistedCanvasStateV1, [{
        id: 'new-asset-id',
        url: 'https://cdn.example.com/generated-image.png',
        sha256: 'new-sha256',
        prompt: '后端回填测试',
      }]);
      
      expect(step4_restored.canvas.length).toBe(1);
      expect(step4_restored.canvas[0].key).toBe('gen_backend_test');
      expect(step4_restored.canvas[0].status).toBe('done');
      expect(step4_restored.canvas[0].src).toBe('https://cdn.example.com/generated-image.png');
    });

    it('模拟：后端找不到元素时创建新元素', () => {
      // 初始空画布
      const initialState: PersistedCanvasStateV1 = {
        schemaVersion: 1,
        elements: [],
      };

      // 模拟后端回填（创建新元素）
      const newElement = {
        id: 'backend_created_element',
        kind: 'image',
        status: 'done',
        src: 'https://cdn.example.com/new-image.png',
        assetId: 'backend-asset-id',
        sha256: 'backend-sha256',
        x: 100,
        y: 200,
        w: 1024,
        h: 1024,
      };
      
      initialState.elements.push(newElement as any);

      // 恢复
      const restored = persistedV1ToCanvas(initialState, [{
        id: 'backend-asset-id',
        url: 'https://cdn.example.com/new-image.png',
        sha256: 'backend-sha256',
      }]);

      expect(restored.canvas.length).toBe(1);
      expect(restored.canvas[0].key).toBe('backend_created_element');
      expect(restored.canvas[0].status).toBe('done');
    });
  });

  describe('边界情况测试', () => {
    
    it('空数组应返回空结果', () => {
      const result = canvasToPersistedV1([]);
      expect(result.state.elements.length).toBe(0);
      expect(result.skippedLocalOnlyImages).toBe(0);
    });

    it('空状态应返回空结果', () => {
      const result = persistedV1ToCanvas({ schemaVersion: 1, elements: [] }, []);
      expect(result.canvas.length).toBe(0);
      expect(result.missingAssets).toBe(0);
      expect(result.localOnlyImages).toBe(0);
    });

    it('应处理缺少 key 的元素', () => {
      const items: CanvasImageItem[] = [{
        key: '', // 空 key
        createdAt: Date.now(),
        prompt: 'no key',
        src: 'https://example.com/image.png',
        status: 'done',
        kind: 'image',
        assetId: 'asset-1',
        x: 0, y: 0, w: 100, h: 100,
      }];

      const result = canvasToPersistedV1(items);
      
      // 应该生成一个 id
      expect(result.state.elements.length).toBe(1);
      expect(result.state.elements[0].id).toMatch(/^el_\d+_[a-f0-9]+$/);
    });

    it('应处理缺少 id 的持久化元素', () => {
      const state: PersistedCanvasStateV1 = {
        schemaVersion: 1,
        elements: [{
          id: '', // 空 id
          kind: 'image',
          src: 'https://example.com/image.png',
        }],
      };

      const result = persistedV1ToCanvas(state, []);
      
      // 应该跳过无效元素
      expect(result.canvas.length).toBe(0);
    });

    it('应正确处理 z 排序', () => {
      const state: PersistedCanvasStateV1 = {
        schemaVersion: 1,
        elements: [
          { id: 'z-high', kind: 'image', src: 'https://a.com/1.png', z: 10 },
          { id: 'z-low', kind: 'image', src: 'https://a.com/2.png', z: 1 },
          { id: 'z-mid', kind: 'image', src: 'https://a.com/3.png', z: 5 },
        ],
      };

      const result = persistedV1ToCanvas(state, []);
      
      expect(result.canvas.length).toBe(3);
      // 应该按 z 值排序
      expect(result.canvas[0].key).toBe('z-low');
      expect(result.canvas[1].key).toBe('z-mid');
      expect(result.canvas[2].key).toBe('z-high');
    });
  });
});

describe('编组的落盘与读回（Cmd+G / Cmd+Shift+G）', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    key: 'k1', createdAt: 1, prompt: 'p', src: '/api/x.png', status: 'done' as const,
    kind: 'image' as const, assetId: 'a1', x: 0, y: 0, w: 10, h: 10, ...over,
  });

  it('编组写得进也读得回', () => {
    const saved = canvasToPersistedV1([item({ frameId: 'f1' })]);
    const { canvas } = persistedV1ToCanvas(saved.state, []);
    expect(canvas[0]!.frameId).toBe('f1');
  });

  it('【关键】解组之后刷新，Frame 不许复活', () => {
    // 真实缺陷（2026-08-11 冒烟抓到）：读回时无条件用 layerGroupId 补 frameId，
    // 于是「解组」在下一次刷新后被撤销——用户会以为快捷键坏了。
    // 新版本写出的记录带迁移标记，此时 frameId 缺失 = 真的解过组。
    const saved = canvasToPersistedV1([item({ frameId: undefined, layerGroupId: 'g1', layerRole: 'layer' as const })]);
    const { canvas } = persistedV1ToCanvas(saved.state, []);
    expect(canvas[0]!.frameId).toBeUndefined();
    // 产物血缘不受影响：解组不该让它忘记自己出自哪一次分层。
    expect(canvas[0]!.layerGroupId).toBe('g1');
  });

  it('旧数据（没有迁移标记）仍然靠 layerGroupId 补出 Frame', () => {
    // 升级前存下来的画布没有 frameId 字段；不补的话既有分层组的 Frame 会整个消失。
    const legacy = {
      schemaVersion: 1 as const,
      elements: [{
        id: 'k1', kind: 'image' as const, x: 0, y: 0, w: 10, h: 10, assetId: 'a1', src: '/api/x.png',
        ext: { layerGroupId: 'g1', layerRole: 'layer' },
      }],
    };
    const { canvas } = persistedV1ToCanvas(legacy, []);
    expect(canvas[0]!.frameId).toBe('g1');
  });
});
