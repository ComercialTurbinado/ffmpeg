const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const multer = require('multer');
const OpenAI = require('openai').default;
const { WaveFile } = require('wavefile');

const app = express();
// Limite alto para save-base64 (imagens em JSON); padrão é 100kb
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.PORT || 3000;
const DATA_ROOT = process.env.DATA_ROOT || '/data/render';
const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
/** FPS do vídeo gerado a partir de sequência de JPEGs (deve bater com a animação do poster: 24 fps = 10s para 240 frames). */
const FPS_VIDEO = 24;
const BASE_URL = process.env.BASE_URL || ''; // opcional: ex. https://n8n-srcleads-ffmpeg-api..../host
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const WHISPER_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB (limite da API Whisper)
const WHISPER_LOCAL_MAX_FILE_SIZE = 25 * 1024 * 1024; // mesmo limite para Whisper local

// Whisper local (Transformers.js) — pipeline carregado sob demanda
let localTranscriberPromise = null;
const WHISPER_LOCAL_MODEL = process.env.WHISPER_LOCAL_MODEL || 'Xenova/whisper-tiny';

async function getLocalTranscriber() {
  if (!localTranscriberPromise) {
    localTranscriberPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('automatic-speech-recognition', WHISPER_LOCAL_MODEL);
    })();
  }
  return localTranscriberPromise;
}

// Converte arquivo de áudio para Float32Array 16kHz mono (formato esperado pelo Whisper local)
async function audioFileToWhisperInput(audioPath) {
  const wavPath = path.join(os.tmpdir(), `whisper-wav-${Date.now()}.wav`);
  const ffmpeg = spawn(FFMPEG, [
    '-y', '-i', audioPath,
    '-ar', '16000', '-ac', '1', '-f', 'wav',
    wavPath
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
  const code = await new Promise((resolve) => ffmpeg.on('close', resolve));

  try {
    if (code !== 0) {
      throw new Error(stderr.slice(-500) || 'FFmpeg falhou ao converter áudio');
    }
    const buffer = await fs.readFile(wavPath);
    const wav = new WaveFile(buffer);
    wav.toBitDepth('32f');
    wav.toSampleRate(16000);
    let audioData = wav.getSamples();
    if (Array.isArray(audioData)) {
      if (audioData.length > 1) {
        const SCALING_FACTOR = Math.sqrt(2);
        for (let i = 0; i < audioData[0].length; ++i) {
          audioData[0][i] = (SCALING_FACTOR * (audioData[0][i] + audioData[1][i])) / 2;
        }
      }
      audioData = audioData[0];
    }
    return Float32Array.from(audioData);
  } finally {
    await fs.unlink(wavPath).catch(() => {});
  }
}

async function transcribeWithLocalWhisper(audioPath) {
  const transcriber = await getLocalTranscriber();
  const audioData = await audioFileToWhisperInput(audioPath);
  const output = await transcriber(audioData, { chunk_length_s: 30, stride_length_s: 5 });
  return output;
}

// Garantir que path está dentro de DATA_ROOT (evitar path traversal)
function resolveSafe(basePath, subPath) {
  const resolved = path.resolve(basePath, subPath || '.');
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new Error('Caminho inválido');
  }
  return resolved;
}

// Ordenação natural (frame_1, frame_2, frame_10...)
function naturalSort(files) {
  return files.sort((a, b) => {
    const aNum = a.replace(/\D/g, '');
    const bNum = b.replace(/\D/g, '');
    if (aNum && bNum) return parseInt(aNum, 10) - parseInt(bNum, 10);
    return String(a).localeCompare(b, undefined, { numeric: true });
  });
}

// POST /jpeg-to-mp4 — pasta com JPEGs → MP4 24fps (qualquer resolução: 1080x1920, 1920x1080, 1080x1350, etc.)
app.post('/jpeg-to-mp4', async (req, res) => {
  const { folderPath, outputPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ error: 'folderPath é obrigatório' });
  }

  try {
    const dir = resolveSafe(DATA_ROOT, folderPath);
    const outPath = outputPath
      ? resolveSafe(DATA_ROOT, outputPath)
      : path.join(dir, 'output.mp4');

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const jpegs = naturalSort(
      entries
        .filter((e) => e.isFile() && /\.(jpe?g|JPE?G)$/.test(e.name))
        .map((e) => path.join(dir, e.name))
    );

    if (jpegs.length === 0) {
      return res.status(400).json({ error: 'Nenhum arquivo JPEG encontrado na pasta' });
    }

    const listPath = path.join(os.tmpdir(), `concat-${Date.now()}.txt`);
    const duration = 1 / FPS_VIDEO;
    const lines = [];
    for (let i = 0; i < jpegs.length; i++) {
      const file = jpegs[i].replace(/'/g, "'\\''");
      lines.push(`file '${file}'`);
      lines.push(`duration ${duration}`);
    }
    lines.push(`file '${jpegs[jpegs.length - 1].replace(/'/g, "'\\''")}'`);
    await fs.writeFile(listPath, lines.join('\n'));

    await fs.mkdir(path.dirname(outPath), { recursive: true });

    const ffmpeg = spawn(FFMPEG, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS_VIDEO),
      outPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });

    const code = await new Promise((resolve) => ffmpeg.on('close', resolve));
    await fs.unlink(listPath).catch(() => {});

    if (code !== 0) {
      return res.status(500).json({ error: 'Erro no FFmpeg', detail: stderr.slice(-500) });
    }

    res.json({ success: true, outputPath: outPath });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// Upload em memória para multipart (limite 50MB por arquivo, 200 arquivos)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 200 }
});

// POST /jpeg-to-mp4-upload — envia os JPEGs no body (multipart); gera MP4 e devolve o arquivo ou salva em outputPath
// Uso: n8n lê os arquivos do próprio volume e envia neste endpoint; não precisa compartilhar volume
app.post('/jpeg-to-mp4-upload', upload.array('frames', 200), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Envie os arquivos JPEG no campo "frames" (multipart/form-data)' });
  }

  const outputPath = req.body.outputPath; // opcional, relativo a DATA_ROOT
  const tmpDir = path.join(os.tmpdir(), `jpeg-upload-${Date.now()}`);
  const outMp4 = path.join(tmpDir, 'out.mp4');

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    const sorted = [...req.files].sort((a, b) =>
      String(a.originalname).localeCompare(b.originalname, undefined, { numeric: true })
    );
    for (let i = 0; i < sorted.length; i++) {
      const ext = path.extname(sorted[i].originalname) || '.jpg';
      await fs.writeFile(path.join(tmpDir, `frame_${String(i + 1).padStart(5, '0')}${ext}`), sorted[i].buffer);
    }

    const listPath = path.join(tmpDir, 'list.txt');
    const duration = 1 / FPS_VIDEO;
    const lines = [];
    const written = await fs.readdir(tmpDir).then((names) => names.filter((n) => /\.(jpe?g|JPE?G)$/i.test(n)).sort());
    for (let i = 0; i < written.length; i++) {
      const f = path.join(tmpDir, written[i]);
      lines.push(`file '${f.replace(/'/g, "'\\''")}'`);
      lines.push(`duration ${duration}`);
    }
    if (written.length > 0) {
      lines.push(`file '${path.join(tmpDir, written[written.length - 1]).replace(/'/g, "'\\''")}'`);
    }
    await fs.writeFile(listPath, lines.join('\n'));

    const ffmpeg = spawn(FFMPEG, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS_VIDEO), outMp4
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
    const code = await new Promise((resolve) => ffmpeg.on('close', resolve));

    for (const f of written) await fs.unlink(path.join(tmpDir, f)).catch(() => {});
    await fs.unlink(listPath).catch(() => {});

    if (code !== 0) {
      await fs.rm(tmpDir, { recursive: true }).catch(() => {});
      return res.status(500).json({ error: 'Erro no FFmpeg', detail: stderr.slice(-500) });
    }

    if (outputPath) {
      const destPath = resolveSafe(DATA_ROOT, outputPath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.rename(outMp4, destPath);
      await fs.rm(tmpDir, { recursive: true }).catch(() => {});
      return res.json({ success: true, outputPath: destPath });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
    const stream = require('fs').createReadStream(outMp4);
    stream.pipe(res);
    stream.on('end', () => fs.rm(tmpDir, { recursive: true }).catch(() => {}));
    stream.on('error', () => fs.rm(tmpDir, { recursive: true }).catch(() => {}));
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// POST /merge-mp4 — sequência de MP4s → um único MP4
app.post('/merge-mp4', async (req, res) => {
  const { folderPath, outputPath, files } = req.body;

  let list;
  let outPath;

  try {
    if (files && Array.isArray(files) && files.length > 0) {
      list = files.map((f) => resolveSafe(DATA_ROOT, f));
      outPath = outputPath
        ? resolveSafe(DATA_ROOT, outputPath)
        : path.join(path.dirname(list[0]), 'merged.mp4');
    } else if (folderPath) {
      const dir = resolveSafe(DATA_ROOT, folderPath);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const mp4s = naturalSort(
        entries
          .filter((e) => e.isFile() && /\.mp4$/i.test(e.name))
          .map((e) => path.join(dir, e.name))
      );
      if (mp4s.length === 0) {
        return res.status(400).json({ error: 'Nenhum MP4 encontrado na pasta' });
      }
      list = mp4s;
      outPath = outputPath
        ? resolveSafe(DATA_ROOT, outputPath)
        : path.join(dir, 'merged.mp4');
    } else {
      return res.status(400).json({ error: 'Envie folderPath ou files (array de caminhos)' });
    }

    const listPath = path.join(os.tmpdir(), `concat-mp4-${Date.now()}.txt`);
    const lines = list.map((f) => `file '${f.replace(/'/g, "'\\''")}'`);
    await fs.writeFile(listPath, lines.join('\n'));

    await fs.mkdir(path.dirname(outPath), { recursive: true });

    const ffmpeg = spawn(FFMPEG, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });

    const code = await new Promise((resolve) => ffmpeg.on('close', resolve));
    await fs.unlink(listPath).catch(() => {});

    if (code !== 0) {
      return res.status(500).json({ error: 'Erro no FFmpeg', detail: stderr.slice(-500) });
    }

    res.json({ success: true, outputPath: outPath });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// POST /video-with-audio — junta um vídeo com um áudio
app.post('/video-with-audio', async (req, res) => {
  const { videoPath, audioPath, outputPath } = req.body;
  if (!videoPath || !audioPath) {
    return res.status(400).json({ error: 'videoPath e audioPath são obrigatórios' });
  }

  try {
    const video = resolveSafe(DATA_ROOT, videoPath);
    const audio = resolveSafe(DATA_ROOT, audioPath);
    const outPath = outputPath
      ? resolveSafe(DATA_ROOT, outputPath)
      : path.join(path.dirname(video), `with-audio-${path.basename(video)}`);

    await fs.access(video);
    await fs.access(audio);
    await fs.mkdir(path.dirname(outPath), { recursive: true });

    const ffmpeg = spawn(FFMPEG, [
      '-y',
      '-i', video,
      '-i', audio,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-shortest',
      outPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });

    const code = await new Promise((resolve) => ffmpeg.on('close', resolve));

    if (code !== 0) {
      return res.status(500).json({ error: 'Erro no FFmpeg', detail: stderr.slice(-500) });
    }

    res.json({ success: true, outputPath: outPath });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// POST /save-base64 — recebe imagens em base64 (ou data URL) e salva na pasta informada
const MAX_BASE64_IMAGES = 200;
const MAX_FILE_SIZE_BASE64 = 50 * 1024 * 1024; // 50MB por imagem

function parseDataUrl(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    const ext = m[1] === 'image/jpeg' || m[1] === 'image/jpg' ? '.jpg' : m[1] === 'image/png' ? '.png' : m[1] === 'image/gif' ? '.gif' : m[1] === 'image/webp' ? '.webp' : '.jpg';
    return { base64: m[2], ext };
  }
  return { base64: str, ext: '.jpg' };
}

// Nome de arquivo seguro (só basename, sem path)
function safeFilename(name) {
  if (typeof name !== 'string') return null;
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.length > 0 ? base : null;
}

app.post('/save-base64', async (req, res) => {
  const { folderPath, images } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images (array) é obrigatório e não pode ser vazio. Cada item: string (base64) ou { data: string, filename?: string }' });
  }
  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ error: 'folderPath é obrigatório' });
  }
  if (images.length > MAX_BASE64_IMAGES) {
    return res.status(400).json({ error: `Máximo ${MAX_BASE64_IMAGES} imagens por requisição` });
  }

  const dir = resolveSafe(DATA_ROOT, folderPath);
  const saved = [];

  try {
    await fs.mkdir(dir, { recursive: true });

    for (let i = 0; i < images.length; i++) {
      const item = images[i];
      const dataStr = typeof item === 'string' ? item : (item && item.data);
      const customName = typeof item === 'object' && item && item.filename ? safeFilename(item.filename) : null;

      const parsed = parseDataUrl(dataStr);
      if (!parsed) {
        return res.status(400).json({ error: `Item ${i + 1}: base64 ou data URL inválido` });
      }
      const buffer = Buffer.from(parsed.base64, 'base64');
      if (buffer.length > MAX_FILE_SIZE_BASE64) {
        return res.status(400).json({ error: `Imagem ${i + 1} muito grande (>${MAX_FILE_SIZE_BASE64 / 1024 / 1024}MB)` });
      }
      const filename = customName
        ? (path.extname(customName) ? customName : customName + parsed.ext)
        : `frame_${String(i + 1).padStart(5, '0')}${parsed.ext}`;
      const filepath = path.join(dir, filename);
      await fs.writeFile(filepath, buffer);
      saved.push(filename);
    }

    res.json({ success: true, folderPath: dir, folderPathRelative: folderPath, saved: saved.length, files: saved });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// POST /save-audio-base64 — recebe áudio em base64 (ou data URL) e salva na pasta informada
const MAX_BASE64_AUDIOS = 50;
const MAX_FILE_SIZE_AUDIO = 50 * 1024 * 1024; // 50MB por arquivo

function parseAudioDataUrl(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    const mime = (m[1] || '').toLowerCase();
    const ext = mime === 'audio/mpeg' || mime === 'audio/mp3' ? '.mp3'
      : mime === 'audio/mp4' || mime === 'audio/m4a' ? '.m4a'
      : mime === 'audio/wav' ? '.wav' : mime === 'audio/ogg' ? '.ogg' : mime === 'audio/webm' ? '.webm'
      : '.mp3';
    return { base64: m[2], ext };
  }
  return { base64: str, ext: '.mp3' };
}

app.post('/save-audio-base64', async (req, res) => {
  const { folderPath, audios } = req.body;
  if (!audios || !Array.isArray(audios) || audios.length === 0) {
    return res.status(400).json({ error: 'audios (array) é obrigatório e não pode ser vazio. Cada item: string (base64) ou { data: string, filename?: string }' });
  }
  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ error: 'folderPath é obrigatório' });
  }
  if (audios.length > MAX_BASE64_AUDIOS) {
    return res.status(400).json({ error: `Máximo ${MAX_BASE64_AUDIOS} áudios por requisição` });
  }

  const dir = resolveSafe(DATA_ROOT, folderPath);
  const saved = [];

  try {
    await fs.mkdir(dir, { recursive: true });

    for (let i = 0; i < audios.length; i++) {
      const item = audios[i];
      const dataStr = typeof item === 'string' ? item : (item && item.data);
      const customName = typeof item === 'object' && item && item.filename ? safeFilename(item.filename) : null;

      const parsed = parseAudioDataUrl(dataStr);
      if (!parsed) {
        return res.status(400).json({ error: `Item ${i + 1}: base64 ou data URL inválido` });
      }
      const buffer = Buffer.from(parsed.base64, 'base64');
      if (buffer.length > MAX_FILE_SIZE_AUDIO) {
        return res.status(400).json({ error: `Áudio ${i + 1} muito grande (>${MAX_FILE_SIZE_AUDIO / 1024 / 1024}MB)` });
      }
      const filename = customName
        ? (path.extname(customName) ? customName : customName + parsed.ext)
        : `audio_${String(i + 1).padStart(3, '0')}${parsed.ext}`;
      const filepath = path.join(dir, filename);
      await fs.writeFile(filepath, buffer);
      saved.push(filename);
    }

    res.json({ success: true, folderPath: dir, folderPathRelative: folderPath, saved: saved.length, files: saved });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// POST /transcribe — transcrição de áudio com OpenAI Whisper ou Whisper local
// Aceita: url (URL do áudio), audioPath (relativo a DATA_ROOT), multipart "audio", ou body.audio (base64/data URL)
const transcribeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WHISPER_MAX_FILE_SIZE, files: 1 }
});

async function transcribeAudio(filePathOrStream, options = {}) {
  if (!openai) {
    throw new Error('Whisper não configurado: defina OPENAI_API_KEY');
  }
  const { language, response_format } = options;
  const payload = {
    file: typeof filePathOrStream === 'string'
      ? require('fs').createReadStream(filePathOrStream)
      : filePathOrStream,
    model: 'whisper-1'
  };
  if (language) payload.language = language;
  if (response_format) payload.response_format = response_format;
  const result = await openai.audio.transcriptions.create(payload);
  return result;
}

app.get('/transcribe', (req, res) => {
  res.status(405).json({
    error: 'Use POST /transcribe',
    message: 'Envie o áudio por: url (URL), audioPath (caminho no servidor), multipart "audio", ou body.audio (base64/data URL).',
    example: { url: 'https://exemplo.com/audio.mp3' }
  });
});

app.post('/transcribe', transcribeUpload.single('audio'), async (req, res) => {
  const { url: audioUrl, audioPath, audio: audioBase64, language, response_format } = req.body || {};
  let tmpPath = null;

  try {
    const maxSize = openai ? WHISPER_MAX_FILE_SIZE : WHISPER_LOCAL_MAX_FILE_SIZE;

    let streamOrPath;

    if (audioUrl && typeof audioUrl === 'string' && isValidUrl(audioUrl.trim())) {
      const resFetch = await fetch(audioUrl.trim(), { redirect: 'follow' });
      if (!resFetch.ok) {
        return res.status(400).json({ error: `Falha ao baixar áudio: ${resFetch.status} ${resFetch.statusText}` });
      }
      const buf = Buffer.from(await resFetch.arrayBuffer());
      if (buf.length > maxSize) {
        return res.status(400).json({ error: `Áudio da URL muito grande (máx. ${Math.round(maxSize / 1024 / 1024)} MB)` });
      }
      const ext = path.extname(new URL(audioUrl).pathname).toLowerCase() || '.mp3';
      const safeExt = /^\.(mp3|wav|m4a|ogg|webm|flac|opus)$/.test(ext) ? ext : '.mp3';
      tmpPath = path.join(os.tmpdir(), `whisper-url-${Date.now()}${safeExt}`);
      await fs.writeFile(tmpPath, buf);
      streamOrPath = tmpPath;
    } else if (req.file && req.file.buffer) {
      if (req.file.size > maxSize) {
        return res.status(400).json({ error: `Arquivo de áudio muito grande (máx. ${Math.round(maxSize / 1024 / 1024)} MB)` });
      }
      const ext = path.extname(req.file.originalname) || '.mp3';
      tmpPath = path.join(os.tmpdir(), `whisper-${Date.now()}${ext}`);
      await fs.writeFile(tmpPath, req.file.buffer);
      streamOrPath = tmpPath;
    } else if (audioPath && typeof audioPath === 'string') {
      const fullPath = resolveSafe(DATA_ROOT, audioPath.trim());
      await fs.access(fullPath);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        return res.status(400).json({ error: 'audioPath não é um arquivo' });
      }
      if (stat.size > maxSize) {
        return res.status(400).json({ error: `Arquivo de áudio muito grande (máx. ${Math.round(maxSize / 1024 / 1024)} MB)` });
      }
      streamOrPath = fullPath;
    } else if (audioBase64) {
      const parsed = parseAudioDataUrl(typeof audioBase64 === 'string' ? audioBase64 : (audioBase64.data || audioBase64));
      if (!parsed) {
        return res.status(400).json({ error: 'audio inválido: use base64 ou data URL (ex.: data:audio/mpeg;base64,...)' });
      }
      const buffer = Buffer.from(parsed.base64, 'base64');
      if (buffer.length > maxSize) {
        return res.status(400).json({ error: `Áudio muito grande (máx. ${Math.round(maxSize / 1024 / 1024)} MB)` });
      }
      tmpPath = path.join(os.tmpdir(), `whisper-${Date.now()}${parsed.ext}`);
      await fs.writeFile(tmpPath, buffer);
      streamOrPath = tmpPath;
    } else {
      return res.status(400).json({
        error: 'Envie o áudio por: url (URL do áudio), audioPath (caminho relativo), campo multipart "audio", ou body.audio (base64/data URL)'
      });
    }

    let result;
    if (openai) {
      result = await transcribeAudio(streamOrPath, { language, response_format });
    } else {
      // Whisper local (Transformers.js) — sem API key
      const output = await transcribeWithLocalWhisper(streamOrPath);
      result = typeof output === 'string' ? { text: output } : (output && typeof output.text !== 'undefined' ? output : { text: String(output) });
    }
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {});

    res.json(result);
  } catch (err) {
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Arquivo não encontrado' });
    const msg = err.message || 'Erro ao transcrever';
    const status = err.status === 401 ? 401 : err.status === 429 ? 429 : 500;
    res.status(status).json({ error: msg });
  }
});

// POST /download-urls — recebe lista de URLs, baixa os arquivos e salva na pasta informada (relativa a /data/render)
const MAX_DOWNLOAD_URLS = 200;
const DOWNLOAD_TIMEOUT_MS = 60000; // 1 min por arquivo
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB por arquivo

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function getExtFromUrl(url) {
  const pathname = new URL(url).pathname;
  const ext = path.extname(pathname).toLowerCase();
  return /^\.(jpe?g|png|gif|webp|bmp)$/.test(ext) ? ext : '.jpg';
}

app.post('/download-urls', async (req, res) => {
  const { urls, folderPath } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls (array) é obrigatório e não pode ser vazio' });
  }
  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ error: 'folderPath é obrigatório' });
  }
  if (urls.length > MAX_DOWNLOAD_URLS) {
    return res.status(400).json({ error: `Máximo ${MAX_DOWNLOAD_URLS} URLs por requisição` });
  }

  const dir = resolveSafe(DATA_ROOT, folderPath);
  const saved = [];

  try {
    await fs.mkdir(dir, { recursive: true });

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (!isValidUrl(url)) {
        return res.status(400).json({ error: `URL inválida (apenas http/https): ${url}` });
      }
      const ext = getExtFromUrl(url);
      const filename = `frame_${String(i + 1).padStart(5, '0')}${ext}`;
      const filepath = path.join(dir, filename);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        clearTimeout(timeout);

        if (!response.ok) {
          return res.status(502).json({ error: `Falha ao baixar ${url}: HTTP ${response.status}` });
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
          return res.status(400).json({ error: `Arquivo muito grande (>${MAX_FILE_SIZE / 1024 / 1024}MB): ${url}` });
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_FILE_SIZE) {
          return res.status(400).json({ error: `Arquivo muito grande (>${MAX_FILE_SIZE / 1024 / 1024}MB): ${url}` });
        }
        await fs.writeFile(filepath, buffer);
        saved.push(filename);
      } catch (fetchErr) {
        const reason = fetchErr.cause?.message || fetchErr.message || 'unknown';
        return res.status(502).json({
          error: `Falha ao baixar URL (${i + 1}/${urls.length})`,
          url,
          detail: reason,
          hint: 'Container pode não ter acesso à internet. Use POST /save-base64 com dados em base64 ou POST /jpeg-to-mp4-upload com multipart.'
        });
      }
    }

    res.json({ success: true, folderPath: dir, folderPathRelative: folderPath, saved: saved.length, files: saved });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Timeout ao baixar arquivo' });
    }
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// GET /list — lista arquivos e pastas em um caminho (query: path=relativo, default: raiz; recursive=true para listar subpastas)
const MAX_LIST_DEPTH = 50;

async function listRecursive(dirFull, dirRelative, baseUrl, depth) {
  if (depth > MAX_LIST_DEPTH) return [];
  const entries = await fs.readdir(dirFull, { withFileTypes: true });
  const result = [];
  const prefix = dirRelative ? dirRelative + '/' : '';
  for (const e of entries) {
    const itemPath = prefix + e.name;
    const isDir = e.isDirectory();
    const item = { name: e.name, path: itemPath, type: isDir ? 'dir' : 'file' };
    if (baseUrl) {
      item.url = baseUrl + (isDir ? '/list?path=' : '/file?path=') + encodeURIComponent(itemPath);
    }
    try {
      const s = await fs.stat(path.join(dirFull, e.name));
      item.size = s.size;
      item.mtime = s.mtime.toISOString();
    } catch (_) {}
    result.push(item);
    if (isDir) {
      const sub = await listRecursive(path.join(dirFull, e.name), itemPath, baseUrl, depth + 1);
      result.push(...sub);
    }
  }
  return result;
}

app.get('/list', async (req, res) => {
  let filePath = req.query.path;
  const recursive = req.query.recursive === 'true' || req.query.recursive === '1';
  if (filePath !== undefined && typeof filePath !== 'string') {
    return res.status(400).json({ error: 'Query "path" deve ser string (caminho relativo a /data/render)' });
  }
  filePath = (filePath || '').replace(/^\/+/, '').replace(/^data\/render\/?/i, '').trim();
  try {
    const fullPath = resolveSafe(DATA_ROOT, filePath || '.');
    const stat = await fs.stat(fullPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'O path deve ser uma pasta' });
    }
    const baseUrl = BASE_URL || null;

    if (recursive) {
      const items = await listRecursive(fullPath, filePath || '', baseUrl, 0);
      return res.json({
        path: filePath || '.',
        pathAbsolute: fullPath,
        recursive: true,
        items: items.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.path.localeCompare(b.path)))
      });
    }

    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const prefix = filePath ? filePath + '/' : '';
    const items = await Promise.all(
      entries.map(async (e) => {
        const itemPath = prefix + e.name;
        const isDir = e.isDirectory();
        const item = { name: e.name, path: itemPath, type: isDir ? 'dir' : 'file' };
        if (BASE_URL) {
          item.url = BASE_URL + (isDir ? '/list?path=' : '/file?path=') + encodeURIComponent(itemPath);
        }
        try {
          const s = await fs.stat(path.join(fullPath, e.name));
          item.size = s.size;
          item.mtime = s.mtime.toISOString();
        } catch (_) {}
        return item;
      })
    );
    res.json({
      path: filePath || '.',
      pathAbsolute: fullPath,
      items: items.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
    });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Pasta não encontrada' });
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// GET /file — baixa um arquivo de /data/render (path relativo no query: ?path=imob/.../video.mp4)
app.get('/file', async (req, res) => {
  let filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'Query "path" é obrigatório (caminho relativo a /data/render)' });
  }
  // Remove barra inicial e prefixo /data/render se vier na URL
  filePath = filePath.replace(/^\/+/, '').replace(/^data\/render\/?/i, '').trim();
  if (!filePath) {
    return res.status(400).json({ error: 'Path não pode ser vazio' });
  }
  try {
    const fullPath = resolveSafe(DATA_ROOT, filePath);
    await fs.access(fullPath);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Não é um arquivo' });
    }
    const ext = path.extname(fullPath).toLowerCase();
    const mime = ext === '.mp4' ? 'video/mp4'
      : ext === '.mp3' || ext === '.m4a' ? 'audio/mpeg'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp'
      : 'application/octet-stream';
    const isImage = /^image\//.test(mime);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${path.basename(fullPath)}"`);
    require('fs').createReadStream(fullPath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Arquivo não encontrado' });
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

// GET /data/render/... — serve arquivo pelo caminho na URL (ex.: /data/render/imob/.../video.mp4)
app.get(/^\/data\/render\/(.*)$/i, async (req, res) => {
  let relativePath = (req.params[0] || req.path.replace(/^\/data\/render\/?/i, '')).trim();
  if (!relativePath) {
    return res.status(400).json({ error: 'Caminho vazio' });
  }
  try {
    relativePath = decodeURIComponent(relativePath).replace(/^\/+/, '').trim();
    if (!relativePath) return res.status(400).json({ error: 'Caminho inválido' });
    const fullPath = resolveSafe(DATA_ROOT, relativePath);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Não é um arquivo ou não encontrado' });
    }
    const ext = path.extname(fullPath).toLowerCase();
    const mime = ext === '.mp4' ? 'video/mp4' : ext === '.mp3' || ext === '.m4a' ? 'audio/mpeg' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(fullPath)}"`);
    require('fs').createReadStream(fullPath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Arquivo não encontrado' });
    res.status(500).json({ error: err.message || 'Erro ao processar' });
  }
});

app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/', (req, res) => res.status(200).send('ok'));

app.get('/info', (req, res) => {
  res.json({
    name: 'FFmpeg API',
    version: '1.0',
    endpoints: {
      'POST /jpeg-to-mp4': 'Sequência de JPEGs → MP4 24fps',
      'POST /jpeg-to-mp4-upload': 'Envia JPEGs em multipart → devolve MP4 (n8n em outro volume)',
      'POST /download-urls': 'Lista de URLs → baixa arquivos e salva em folderPath',
      'POST /save-base64': 'Array de base64 ou data URL → salva imagens em folderPath',
      'POST /save-audio-base64': 'Array de base64 ou data URL (áudio: mp3, m4a, wav, etc.) → salva em folderPath',
      'POST /merge-mp4': 'Vários MP4s → um único vídeo',
      'POST /video-with-audio': 'Vídeo + áudio → um arquivo',
      'POST /transcribe': 'Áudio → transcrição (Whisper local ou OpenAI se OPENAI_API_KEY estiver definida)',
      'GET /file': 'Baixa arquivo (query: path=relativo/a/arquivo.mp4)',
      'GET /data/render/*': 'Serve arquivo pela URL (ex.: /data/render/imob/.../video.mp4)',
      'GET /list': 'Lista arquivos e pastas (path=relativo; recursive=true para subpastas)',
      'GET /health': 'Health check',
      'GET /info': 'Info da API'
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FFmpeg API rodando na porta ${PORT}`);
});
