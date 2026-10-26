// Turntable and video export plans: frame angles, sizes, ffmpeg arguments and file names. Pure, shared by the
// Render view, batch export and the tests. Encoding runs locally with ffmpeg; nothing is ever uploaded.

export const RESOLUTIONS = {
  '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '4k': [3840, 2160], square: [1080, 1080], vertical: [1080, 1920],
};
export const FORMATS = { mp4: 'MP4 (H.264)', webm: 'WebM (VP9)', webmAlpha: 'WebM with alpha', png: 'PNG sequence' };
export const QUALITIES = { draft: 28, good: 20, high: 16, max: 12 }; // CRF

/** { angles: [deg per frame], width, height, fps, frames, seconds } */
export function planTurntable({ degrees = 360, frames = 72, fps = 30, resolution = '1080p', start = 0 } = {}) {
  if (![360, 180].includes(degrees)) throw new Error('Turn 360 or 180 degrees');
  if (!Number.isInteger(frames) || frames < 2 || frames > 7200) throw new Error('Frames must be 2 to 7200');
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('Frame rate must be 1 to 120');
  const res = RESOLUTIONS[resolution];
  if (!res) throw new Error(`Unknown resolution ${resolution}`);
  // A full turn must not repeat its first frame at the end; a half turn ends on the far side.
  const step = degrees === 360 ? degrees / frames : degrees / (frames - 1);
  const angles = Array.from({ length: frames }, (_, i) => +(start + i * step).toFixed(6));
  return { angles, width: res[0], height: res[1], fps, frames, seconds: frames / fps };
}

/** PNG sequence name for frame i: pattern tokens {name} {variant} {frame}. */
export function frameName(pattern = '{name}_{frame}', { name = 'turntable', variant = '', frame = 0, digits = 4 } = {}) {
  const safe = (s) => String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${pattern.replace('{name}', safe(name)).replace('{variant}', safe(variant)).replace('{frame}', String(frame).padStart(digits, '0'))}.png`.replace(/[_-]{2,}/g, '_');
}
/** ffmpeg input pattern matching frameName. */
export const framePattern = (pattern = '{name}_{frame}', opts = {}) => frameName(pattern, { ...opts, frame: 0 }).replace(/0{4}\.png$/, '%04d.png');

/** ffmpeg arguments: input is a PNG sequence pattern, output the file. format: mp4 | webm | webmAlpha. */
export function ffmpegArgs({ input, output, fps = 30, format = 'mp4', quality = 'good', width, height, seconds } = {}) {
  if (!input || !output) throw new Error('Input and output are required');
  const crf = QUALITIES[quality];
  if (crf == null) throw new Error(`Unknown quality ${quality}`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', input];
  const vf = [];
  if (width && height) vf.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
  if (format === 'mp4') {
    if (width && height) vf[1] = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    args.push(...(vf.length ? ['-vf', vf.join(',')] : []), '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  } else if (format === 'webm') {
    args.push(...(vf.length ? ['-vf', vf.join(',')] : []), '-c:v', 'libvpx-vp9', '-crf', String(crf + 10), '-b:v', '0', '-pix_fmt', 'yuv420p');
  } else if (format === 'webmAlpha') {
    args.push(...(vf.length ? ['-vf', vf.join(',')] : []), '-c:v', 'libvpx-vp9', '-crf', String(crf + 10), '-b:v', '0', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0');
  } else throw new Error(`ffmpeg can't write ${format}`);
  if (seconds) args.push('-t', String(seconds));
  args.push('-an', output);
  return args;
}
export const extensionFor = (format) => ({ mp4: '.mp4', webm: '.webm', webmAlpha: '.webm', png: '' }[format]);
