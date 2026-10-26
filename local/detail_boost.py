"""Detail Boost: the free, local finishing pass on a TRELLIS model. No network, no paid services.

1. Upscale the base color texture with Real-ESRGAN (x4plus, BSD-3) when its weights are present; otherwise a
   Lanczos resize so the pass still runs.
2. Derive a height map from the photo-baked texture (luminance, high-passed) and a tangent-space normal map from it.
3. Project the height onto the mesh: nudge each vertex along its normal by the height under its UV (small, scaled
   to the model size), and attach the normal map to the material.
Pure numpy/PIL for 2 and 3 so they can be tested without a GPU. trimesh is only needed by boost_glb().
"""
import numpy as np
from PIL import Image, ImageFilter


def upscale(img, weights=None, target=4096):
    """Real-ESRGAN when weights (a .pth path) and the realesrgan package are there, else Lanczos. Caps at target px."""
    img = img.convert('RGB')
    out, how = None, 'lanczos'
    if weights:
        try:
            import torch
            from basicsr.archs.rrdbnet_arch import RRDBNet
            from realesrgan import RealESRGANer
            net = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
            up = RealESRGANer(scale=4, model_path=weights, model=net, tile=512, half=torch.cuda.is_available())
            arr, _ = up.enhance(np.asarray(img)[:, :, ::-1], outscale=4)
            out, how = Image.fromarray(arr[:, :, ::-1]), 'realesrgan'
        except Exception:
            out = None
    side = min(target, max(img.size) * 4)
    if out is None:
        out = img.resize((side, side * img.size[1] // img.size[0]), Image.LANCZOS)
    elif max(out.size) > target:
        out = out.resize((target, target * out.size[1] // out.size[0]), Image.LANCZOS)
    return out, how


def height_map(img, radius=8):
    """0..1 height from texture detail: luminance minus its blur, so lighting gradients don't become bumps."""
    g = img.convert('L')
    base = np.asarray(g, dtype=np.float32) / 255
    low = np.asarray(g.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255
    h = base - low
    span = max(float(np.abs(h).max()), 1e-6)
    return np.clip(0.5 + 0.5 * h / span, 0, 1)


def normal_map(h, strength=2.0):
    """Tangent-space normal map (RGB uint8, OpenGL +Y as glTF expects) from a height map, by Sobel slopes."""
    p = np.pad(h, 1, mode='edge')
    dx = (p[1:-1, 2:] - p[1:-1, :-2]) * 0.5
    dy = (p[2:, 1:-1] - p[:-2, 1:-1]) * 0.5
    n = np.dstack([-dx * strength, dy * strength, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return ((n * 0.5 + 0.5) * 255).round().astype(np.uint8)


def displace(vertices, normals, uv, h, amount):
    """Move each vertex along its normal by (height - 0.5) * amount, sampled at its UV (glTF: v down from top)."""
    H, W = h.shape
    x = np.clip((uv[:, 0] % 1) * (W - 1), 0, W - 1).round().astype(int)
    y = np.clip((uv[:, 1] % 1) * (H - 1), 0, H - 1).round().astype(int)
    return vertices + normals * ((h[y, x] - 0.5) * amount)[:, None]


def boost_glb(src, dst, weights=None, target=4096, depth=0.004):
    import trimesh
    scene = trimesh.load(src, force='scene')
    size = float(np.linalg.norm(scene.extents)) or 1.0
    report = {'upscaler': None, 'meshes': 0}
    for mesh in scene.geometry.values():
        mat = getattr(mesh.visual, 'material', None)
        tex = getattr(mat, 'baseColorTexture', None)
        uv = getattr(mesh.visual, 'uv', None)
        if tex is None or uv is None:
            continue
        big, how = upscale(tex, weights, target)
        h = height_map(big)
        mat.baseColorTexture = big
        mat.normalTexture = Image.fromarray(normal_map(h))
        mesh.vertices = displace(np.asarray(mesh.vertices), np.asarray(mesh.vertex_normals), np.asarray(uv), h, depth * size)
        report.update(upscaler=how)
        report['meshes'] += 1
    scene.export(dst)
    return report
