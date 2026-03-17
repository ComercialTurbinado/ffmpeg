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

**Se aparecer "Service is not reachable" no Easypanel:**
- Confira os **logs** do container (pode ter crash ou OOM ao carregar Whisper).
- **Health check:** a API expõe `GET /health` → responde `ok`. No Easypanel, configure o health check para esse path na **mesma porta** em que o app sobe (ex.: `3000` ou a variável `PORT` que o painel injeta). O Dockerfile já inclui `HEALTHCHECK`; se o painel usar outro esquema, aponte para `/health`.
- **Memória:** Whisper local (Transformers.js) usa bastante RAM na primeira requisição; aumente o limite de memória do app se o container for morto (OOM).
- **POST /transcribe devolve a página de erro mas GET /health responde "ok":** a requisição de transcrição demora (1–3 min na primeira vez, 30–90 s depois). O proxy (Traefik) pode estar encerrando por **timeout**. Aumente o timeout do proxy para este serviço (ex.: 180 s). No Easypanel isso costuma ser feito via configuração customizada do Traefik ou anotações do app; consulte a doc do Easypanel (Custom Traefik Configuration).

**Pasta de trabalho:** a raiz dos caminhos é **`/data/render`**. O n8n pode criar subpastas dinamicamente (ex.: `job-123`, `2025-03-03`, etc.); a API cria as pastas de destino automaticamente quando gera o arquivo de saída.

## Variáveis de ambiente

| Variável   | Padrão | Descrição                    |
|-----------|--------|------------------------------|
| `PORT`    | 3000   | Porta HTTP da API            |
| `DATA_ROOT` | /data/render | Raiz dos caminhos de arquivos |
| `OPENAI_API_KEY` | — | Opcional. Se definida, usa a API OpenAI para transcrição. Se não definida, usa Whisper local (Transformers.js), sem custo nem API key. |
| `WHISPER_LOCAL_MODEL` | Xenova/whisper-tiny | Modelo Hugging Face para Whisper local (ex.: Xenova/whisper-small para mais precisão). |
| `DEEPSEEK_API_KEY` | — | Opcional. Se definida e o body enviar `correctWithDeepSeek: true`, o texto transcrito é enviado à API DeepSeek para correção de português antes de montar o SRT ou retornar o texto. |
| `DEEPSEEK_MODEL` | deepseek-chat | Modelo DeepSeek (ex.: deepseek-chat, deepseek-reasoner). |

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

### 4. Transcrição de áudio (Whisper)

**POST** `/transcribe`

Transcreve áudio com Whisper. Funciona de duas formas (sem quebrar nada):

- **Sem `OPENAI_API_KEY`:** usa Whisper **local** (Transformers.js), sem custo e sem API key. Na primeira requisição o modelo é baixado e cacheado.
- **Com `OPENAI_API_KEY`:** usa a API da OpenAI (mesmo formato de resposta).

Áudio até 25 MB. Formatos: mp3, m4a, wav, webm, etc.

**Opção — URL do áudio (JSON):**

```json
{
  "url": "https://exemplo.com/audio/narracao.mp3"
}
```

**Opção A — caminho no servidor (JSON):**

```json
{
  "audioPath": "pasta/meu-audio.mp3",
  "language": "pt",
  "response_format": "text"
}
```

**Opção B — áudio em base64 (JSON):**

```json
{
  "audio": "data:audio/mpeg;base64,...",
  "language": "pt"
}
```

**Opção C — upload multipart:** campo `audio` com o arquivo (mp3, m4a, wav, webm, etc.).

- `url` — URL pública do áudio (o servidor baixa e transcreve).
- `audioPath` — caminho relativo a `/data/render` (opção A).
- `audio` — string em base64 ou data URL (opção B).
- `language` — opcional; código ISO (ex.: `pt`, `en`). No Whisper local o padrão é `portuguese` (transcrição em português do Brasil).
- `response_format` — opcional; `text` (padrão), `json`, `srt`, `verbose_json`, `vtt`.
- `correctWithDeepSeek` — opcional; se `true` e `DEEPSEEK_API_KEY` estiver definida, o texto (ou cada segmento do SRT) é enviado à DeepSeek para correção de português antes de retornar.

**Resposta (exemplo com response_format text):** `{ "text": "transcrição aqui..." }`

Se `response_format` for **`srt`**:

- Com **`OPENAI_API_KEY`** → usa o formato SRT da própria API da OpenAI.
- Sem `OPENAI_API_KEY` (Whisper local) → o servidor monta um SRT a partir dos timestamps dos trechos reconhecidos.
- Com **`correctWithDeepSeek: true`** e **`DEEPSEEK_API_KEY`** → após a transcrição, cada segmento é corrigido pela DeepSeek e o SRT é devolvido com o texto corrigido (timestamps mantidos).

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
