# FFmpeg API para EasyPanel

API em Node.js + FFmpeg para:
1. **JPEG → MP4** — pasta com sequência de JPEGs → vídeo 24fps (qualquer resolução: 1080×1920, 1920×1080, 1080×1350, etc.)
2. **Merge MP4** — vários MP4s → um único vídeo
3. **Vídeo + áudio** — junta um vídeo com um arquivo de áudio

## Subir no EasyPanel (Composer)

1. No EasyPanel, vá em **Composer** e importe/crie um novo compose.
2. Cole o conteúdo de `docker-compose.yml` ou use **Add from URL** apontando para este repositório.
3. **Volume de dados**: por padrão o compose usa o volume nomeado `ffmpeg-data`. Para usar uma pasta do host (recomendado para enviar JPEGs/MP4s), edite o compose e troque:

   ```yaml
   volumes:
     - ffmpeg-data:/data
   ```

   por (ajuste o caminho do host):

   ```yaml
   volumes:
     - /caminho/no/host/para/media:/data
   ```

   e remova a seção `volumes:` no final do arquivo se não usar mais o volume nomeado.

4. Build e start do serviço. A API fica em `http://seu-servidor:3000`.

**Pasta de trabalho:** a raiz dos caminhos é **`/data/render`**. O n8n pode criar subpastas dinamicamente (ex.: `job-123`, `2025-03-03`, etc.); a API cria as pastas de destino automaticamente quando gera o arquivo de saída.

## Variáveis de ambiente

| Variável   | Padrão | Descrição                    |
|-----------|--------|------------------------------|
| `PORT`    | 3000   | Porta HTTP da API            |
| `DATA_ROOT` | /data/render | Raiz dos caminhos de arquivos |

Todos os caminhos enviados nos endpoints são relativos a `DATA_ROOT` (ou seja, a `/data/render`). O n8n pode criar pastas dinamicamente (ex.: por job ou por data); a API cria os diretórios pai do arquivo de saída automaticamente (`mkdir -p`), então basta enviar o `outputPath` (ou `folderPath`) desejado.

## Endpoints

### 1. JPEG → MP4 (24fps)

**POST** `/jpeg-to-mp4`

- Aceita qualquer resolução (ex.: 1080×1920, 1920×1080, 1080×1350); o FFmpeg mantém o tamanho dos JPEGs.
- Os JPEGs são ordenados por nome (ordem natural: 1, 2, 10, 11…).

**Body (JSON):**

```json
{
  "folderPath": "minha-pasta-de-frames",
  "outputPath": "minha-pasta-de-frames/video.mp4"
}
```

- `folderPath` — obrigatório; pasta (relativa a `/data/render`) com os JPEGs.
- `outputPath` — opcional; pode ser um caminho em pasta criada dinamicamente pelo n8n (ex.: `job-{{ $runId }}/video.mp4`); a API cria a pasta se não existir.

**Exemplo com curl:**

```bash
curl -X POST http://localhost:3000/jpeg-to-mp4 \
  -H "Content-Type: application/json" \
  -d '{"folderPath": "sequencia1", "outputPath": "sequencia1/resultado.mp4"}'
```

---

### 2. Juntar vários MP4s em um só

**POST** `/merge-mp4`

**Opção A — pasta:** todos os `.mp4` da pasta são unidos em ordem alfabética/natural.

**Body (JSON):**

```json
{
  "folderPath": "pasta-com-mp4s",
  "outputPath": "pasta-com-mp4s/merged.mp4"
}
```

**Opção B — lista de arquivos:** você informa a ordem.

```json
{
  "files": ["pasta/clip1.mp4", "pasta/clip2.mp4", "pasta/clip3.mp4"],
  "outputPath": "pasta/final.mp4"
}
```

- `outputPath` — opcional; se omitido, grava `merged.mp4` na pasta dos arquivos (quando usar `folderPath`) ou na pasta do primeiro arquivo (quando usar `files`).

**Exemplo:**

```bash
curl -X POST http://localhost:3000/merge-mp4 \
  -H "Content-Type: application/json" \
  -d '{"folderPath": "meus-clips", "outputPath": "meus-clips/merged.mp4"}'
```

---

### 3. Vídeo + áudio

**POST** `/video-with-audio`

**Body (JSON):**

```json
{
  "videoPath": "videos/meu-video.mp4",
  "audioPath": "audios/trilha.mp3",
  "outputPath": "videos/meu-video-com-audio.mp4"
}
```

- `videoPath` e `audioPath` — obrigatórios.
- `outputPath` — opcional; se omitido, gera um arquivo na mesma pasta do vídeo com prefixo `with-audio-`.
- A duração do resultado segue o **vídeo** (`-shortest`).

**Exemplo:**

```bash
curl -X POST http://localhost:3000/video-with-audio \
  -H "Content-Type: application/json" \
  -d '{"videoPath": "merged.mp4", "audioPath": "musica.mp3", "outputPath": "final.mp4"}'
```

---

### Health check

**GET** `/health` — retorna `{"ok": true}`.

## Fluxo típico

1. Montar no container uma pasta com:
   - subpasta com sequência de JPEGs **ou**
   - vários MP4s **e** um áudio.
2. Chamar `POST /jpeg-to-mp4` com `folderPath` da pasta dos JPEGs → gera um MP4.
3. (Opcional) Chamar `POST /merge-mp4` com `folderPath` da pasta dos MP4s → gera um único MP4.
4. Chamar `POST /video-with-audio` com `videoPath` do MP4 e `audioPath` do áudio → gera o vídeo final com áudio.

## Desenvolvimento local

```bash
npm install
npm run dev
```

Requer FFmpeg instalado na máquina. Para testar com a mesma raiz de dados:

```bash
DATA_ROOT=/caminho/para/pasta node src/server.js
```
