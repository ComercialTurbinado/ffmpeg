const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_ROOT = process.env.DATA_ROOT || '/data/render';

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

// POST /jpeg-to-mp4 — pasta com JPEGs → MP4 30fps (qualquer resolução: 1080x1920, 1920x1080, 1080x1350, etc.)
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
    const duration = 1 / 30;
    const lines = [];
    for (let i = 0; i < jpegs.length; i++) {
      const file = jpegs[i].replace(/'/g, "'\\''");
      lines.push(`file '${file}'`);
      lines.push(`duration ${duration}`);
    }
    lines.push(`file '${jpegs[jpegs.length - 1].replace(/'/g, "'\\''")}'`);
    await fs.writeFile(listPath, lines.join('\n'));

    await fs.mkdir(path.dirname(outPath), { recursive: true });

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
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

    const ffmpeg = spawn('ffmpeg', [
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

    const ffmpeg = spawn('ffmpeg', [
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

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FFmpeg API rodando na porta ${PORT}`);
});
