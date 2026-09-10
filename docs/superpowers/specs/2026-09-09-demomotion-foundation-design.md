# DemoMotion — Design de fundação (v1 OSS)

Data: 2026-09-09
Status: proposto, aguardando revisão
Escopo: sub-projetos 0 e 1 (fundação verificada + qualidade cinematográfica)

## 0. O que este documento é — e o que o projeto não tem

Este é um documento de **arquitetura de software**: quais módulos existem, quem
fala com quem, em que formato os dados trafegam. "Design" aqui tem o mesmo sentido
que em "design de API". Não há nesta spec nenhuma decisão visual, e o projeto não
tem frontend.

**DemoMotion é 100% MCP.** A única interface é a superfície de ferramentas que o
agente chama. Nenhum passo do fluxo depende de humano clicando. O navegador pode
ser exibido (`headless: false`) para que se acompanhe a execução, mas quem opera o
produto é o Playwright dirigido pelo agente — a janela é observação, nunca entrada.

O objetivo é entregar um vídeo comparável ao que um humano produziria numa
ferramenta como o Recordly, gerado inteiramente de forma agêntica. Não é reimplementar
o produto Recordly, e nenhuma linha dele é usada.

Onde vive a parte visual: no compositor Remotion, que recebe `project.json` como
props e resolve, frame a frame, posição de câmera e sobreposições. Escrever isso é
escrever matemática de tempo e de recorte, não interface.

**Uma ressalva sobre `apps/studio`.** O script `remotion studio` abre o Remotion
Studio, que *é* uma UI para humano. Ela não pertence ao caminho agêntico: serve
apenas para depurar a composição durante o desenvolvimento e inspecionar um frame
de perto. Nenhuma ferramenta MCP depende dela, e o render em produção roda por CLI,
sem interface. Quem chegar ao repositório não deve confundi-la com um editor.

## 1. Ponto de partida

O repositório é um esqueleto de ~776 linhas que **nunca foi executado**. Isso está
registrado pelo próprio autor em `RELEASE_CHECKLIST.md:14`, e é corroborado pela
ausência de `pnpm-lock.yaml`, pela CI rodando com `--frozen-lockfile=false` e por
`scripts/offline-core-test.mjs:4`, que carrega TypeScript de um caminho absoluto
(`/opt/nvm/versions/node/v22.16.0/...`) que não existe nesta máquina.

As três únicas asserções do projeto exercitam `buildAutoZooms`, uma função pura.
Nada toca MCP, Playwright, Remotion ou render.

Defeitos legíveis sem execução:

| Onde | Defeito | Consequência |
|---|---|---|
| `apps/studio/src/video/DemoMotion.tsx:71` | `objectFit: "cover"` numa caixa cuja razão de aspecto difere da fonte | O produto aparece cortado, silenciosamente |
| `packages/schema/src/index.ts` + composição | `trims` existe no schema e é ignorado na renderização | Feature declarada que não faz nada |
| `apps/mcp-server/src/render.ts:17`, `session-manager.ts:24` | Caminhos resolvidos contra `cwd` | Um servidor MCP é lançado pelo cliente, de qualquer diretório |
| `session-manager.ts:22` vs `recordVideo` | Eventos em `Date.now()`, vídeo em VFR sem timestamps expostos | Zoom fora de lugar; a tese "metadata é fonte de verdade" não se sustenta |
| `session-manager.ts:70` | Allowlist aplicada só em `goto` | Um clique navega para qualquer host; redirects não são checados |
| `session-manager.ts` (global) | Sessões sem timeout nem cleanup | Browsers vazam se `session_stop` nunca vier |

O problema central não é a lista. É que **nada foi verificado**. Pelo padrão de
testes deste projeto, um verde que nunca foi vermelho não prova nada.

## 2. Princípios

1. **Verdade por construção, não por inferência.** Se um fato pode ser registrado
   no momento em que acontece, ele nunca é reconstruído depois analisando pixels.
2. **Capturar fatos uma vez; decidir estética depois.** Recorte, zoom, cursor,
   legenda e ritmo pertencem à composição, nunca à gravação.
3. **Uma feature declarada no schema tem que ter efeito observável**, provado por
   um teste que já falhou uma vez.

## 3. Modelo de tempo — a peça central

O bug de `trims` não é esquecimento: falta uma camada. No instante em que existe
corte ou aceleração, passam a existir **duas bases de tempo**, e todo elemento
precisa declarar em qual delas vive.

- **`sourceMs`** — tempo na captura bruta. `t=0` no primeiro frame capturado.
  Eventos e frames vivem aqui. É imutável: descreve o que aconteceu.
- **`outputMs`** — tempo no vídeo final. `t=0` no primeiro frame renderizado.
  Muda toda vez que a edição muda.

### EditList

A ponte entre as duas é uma lista ordenada de segmentos:

```ts
type EditSegment = {
  sourceFromMs: number;
  sourceToMs: number;
  speed: number;      // 1 = normal, 2.5 = acelerado
};
type EditList = EditSegment[];
```

Duração de saída de um segmento = `(sourceToMs - sourceFromMs) / speed`.
A soma acumulada dá o `outputFromMs` de cada segmento.

```
outputMs → segmento → sourceMs = sourceFromMs + (outputMs - outputFromMs) * speed
sourceMs → segmento que o contém → outputMs   (ou "cortado", se não estiver em nenhum)
```

**Trims e speed ramps colapsam numa estrutura só.** O que não está em nenhum
segmento foi cortado; `speed ≠ 1` é rampa. Não existe campo `trims` separado —
foi ele que ficou órfão. A composição lê **apenas** a EditList, então uma feature
de corte que não tem efeito passa a ser impossível de escrever.

### Em qual base cada coisa vive

Zooms, callouts, legendas e cursor são ancorados em **`sourceMs`** — em *o que
aconteceu*, não em *onde foi parar*. O compositor os projeta para `outputMs` pela
EditList. Consequência prática: recortar um trecho reposiciona automaticamente
todo o resto. Não há ressincronização manual, porque não há nada dessincronizado.

A exceção são elementos que não correspondem a nenhum instante da fonte (cartela
de abertura, encerramento). Esses vivem em `outputMs` e ficam numa lista separada,
`outputOverlays`. v1 não precisa deles; a separação existe para que o dia em que
precisar não vire remendo.

### Frames

Como a grade de captura é de fps constante (§4), `sourceMs → índice de frame` é
exato: `round(sourceMs / 1000 * fps)`. Sem estimativa, sem calibração.

## 4. Captura — adapter de screencast determinístico

Substitui `recordVideo` do Playwright.

Loop via CDP: `Page.startScreencast` entrega cada frame com `metadata.timestamp`.
Nós montamos os frames numa **grade de fps constante**, posicionando cada um pelo
seu próprio timestamp e repetindo o último frame nos intervalos sem mudança
(o screencast só emite quando a página muda — trecho parado custa quase nada).

Ganhos:
- O mapa evento↔frame é exato **por construção**.
- `deviceScaleFactor > 1` captura acima da resolução nativa — é daí que vem a
  nitidez que se espera de uma ferramenta de demo.
- A `CaptureAdapter` vira uma abstração honesta: o contrato é "artefato CFR +
  eventos na mesma base de tempo", que um adapter de desktop também consegue
  cumprir. Com `recordVideo`, a interface escondia uma incompatibilidade.

### Contrato do adapter

```ts
interface CaptureResult {
  fps: number;              // constante, garantido
  width: number;
  height: number;
  frameCount: number;
  artifact: { kind: "frames"; dir: string } | { kind: "video"; path: string };
  events: CaptureEvent[];   // sourceMs
}
```

**Invariante que todo adapter deve cumprir:** o frame `i` corresponde a
`sourceMs = i / fps * 1000`. Um adapter que não consegue garantir isso não é um
adapter válido — é o que o `recordVideo` era.

### Cursor

O screencast **não desenha o ponteiro**. Então o cursor é necessariamente uma
camada sintética — não é escolha de design, é a única saída.

Mas há um detalhe que evita inferência: em vez de adivinhar o trajeto depois, o
agente **comanda** o movimento (`page.mouse.move` em passos) antes de cada
interação. Isso serve a dois propósitos ao mesmo tempo — dispara os estados de
`:hover` reais na gravação, e torna a trilha do cursor exata por construção, pelo
mesmo princípio do §3. A trilha é registrada como keyframes; a suavização e o
pulso de clique são decisão de composição.

## 5. Câmera

Zoom deixa de ser `scale` + `transform-origin` e passa a ser um **retângulo de
câmera** em coordenadas normalizadas da fonte, mapeado para o viewport de saída.

Isso generaliza três coisas que hoje são separadas ou inexistentes:
- zoom (retângulo menor que o frame),
- reenquadramento 16:9 → 9:16 (retângulo de razão diferente),
- correção do `objectFit: "cover"` (o retângulo carrega a razão de aspecto correta,
  então não há corte acidental — todo corte passa a ser explícito).

Interpolação com easing real (`Easing.bezier`), não linear. O retângulo é limitado
às bordas do frame, de modo que um alvo perto da margem aproxima o quanto pode sem
revelar vazio.

## 6. Testes

Seguindo o padrão do projeto:

- **Cada teste tem duas metades.** Ex.: a EditList corta o trecho pedido **e** o
  material fora do corte continua íntegro e na posição certa.
- **Nada de vacuidade.** Antes de afirmar "o zoom não aparece aqui", semear um
  zoom e confirmar que ele aparece em algum lugar.
- **Valor esperado de fonte independente.** O mapeamento `outputMs ↔ sourceMs` é
  verificado contra exemplos calculados à mão na spec, não recalculados pela
  mesma função que está sob teste.
- **O seam é a tela.** Para o compositor, renderizar frames específicos e inspecionar
  o pixel — não basta a composição montar sem erro.
- **O dado vem pelo produto.** A captura é exercitada operando um app-alvo real
  (fixture no repositório, servido localmente), não com `capture.json` escrito à mão.

Cobertura será relatada como fração e escopo. Nunca "~100%".

## 7. Escopo do v1

Dentro:
- Adapter de screencast determinístico + contrato CFR
- Camada de tempo (EditList) com corte e rampa de velocidade
- Câmera por retângulo, com easing e limites
- Cursor sintético comandado
- Legendas script-first (o agente já sabe o texto; sem transcrição, sem API key)
- Callouts com safe area
- Superfície MCP endurecida: allowlist em navegação e redirects, isolamento de
  filesystem, timeout e cleanup de sessão
- CI que instala, typechecka, testa **e renderiza um MP4 de verdade**

Fora (adiado, com razão):
- Voiceover/TTS — exigiria API key obrigatória, fricção de adoção em OSS
- Detecção de cena, planner criativo por LLM, validação por VLM
- Adapter de desktop, adapter de replay de DOM
- Qualquer coisa de nuvem

## 8. Estado de verificação (levantamento de 2026-09-09)

Levantamento executado nesta máquina: Darwin 22.6.0 (macOS 13), Node v26.8.1,
pnpm 10.17.1, ffmpeg 7.1.1.

### Verificado por execução — funciona

- `pnpm install` sai 0. As quatro dependências que eu havia tratado como suspeitas
  são todas reais e instalam nas versões fixadas: `@modelcontextprotocol/server@2.0.0`,
  `playwright@1.63.0`, `remotion@4.0.521`, `typescript@6.0.3` (de `^6.0.0`).
- **A superfície MCP está correta.** `registerTool` aceita `z.object(...)` — e essa
  é a forma **preferida**; a shape crua é que está marcada `@deprecated`. O
  `serveStdio` existe no subpath `./stdio`. Verificado lendo o `.d.mts`/`.mjs`
  instalado **e** executando uma chamada real de `registerTool` que produziu JSON
  Schema válido. A hipótese de reescrita da camada MCP está descartada.
- **O servidor sobe e fala protocolo.** Handshake `initialize` respondido
  (`protocolVersion 2025-06-18`), `tools/list` devolveu as 15 ferramentas com
  schemas corretos.
- `pnpm test` sai 0: 3 de 3 asserções, todas em `packages/core/test/zoom.test.ts`.
  Escopo da cobertura: **1 arquivo de teste, 1 função pura**. Nada em
  `apps/mcp-server` ou `apps/studio` é exercitado.

### Verificado por execução — quebrado

- `pnpm typecheck` falha com 3 erros: dois em `apps/studio` (TS2835, NodeNext exige
  extensão `.js` explícita) e um em `apps/mcp-server:131` (TS2345, `style`
  todo-opcional do schema de `project_update` contra o `Partial<Pick<...>>` de
  `updateProject`).
- `pnpm build` falha **e mesmo assim emite `dist/`**, porque `noEmitOnError` está
  desligado. Um `dist/` populado não é prova de build verde.
- `pnpm -r` aborta no primeiro projeto que falha e **mascara** os de baixo: o erro
  do mcp-server só apareceu rodando aquele projeto sozinho.
- `pnpm dev:mcp` escreve 8 linhas de banner no **stdout** antes do primeiro frame
  JSON-RPC — e é exatamente o comando que o README entrega aos clientes MCP.
- O comando de provisionamento documentado (`pnpm exec playwright install chromium`,
  da raiz) **não alcança o Playwright do repositório**. Nesta máquina ele caiu num
  Playwright de sistema, saiu 0 e removeu um navegador do cache. Zero ali é
  artefato, não resultado.

### O bloqueio de plataforma

```
ERROR: Playwright does not support chromium on mac13
```

Playwright 1.63.0 exige `chromium-1243`, que não tem build para macOS 13.
`chromium.launch()` falha com `Executable doesn't exist`. **Toda a metade de
captura está inoperante nesta máquina** — não por bug de código, mas por conflito
entre o pin de versão e o SO.

**Decisão:** o lançamento do browser passa a ser configurável por
`DEMOMOTION_BROWSER_CHANNEL`. Definido como `chrome`, usa o Google Chrome instalado
(152.0.7977.84 nesta máquina), que funciona no macOS 13 sem download. Não definido,
mantém o Chromium empacotado — a CI continua determinística, como pede o §26 do
documento original. O CDP screencast do §4 funciona igual nos dois.

### Ainda não verificado — não leia como saudável

- **Toda ferramenta de captura** (`session_start`, `browser_*`, `session_stop`):
  bloqueada pelo problema acima. Provou-se apenas que estão *listadas*; nenhuma foi
  chamada.
- **`render_video`, `demo_finalize`, `project_build`, `project_update` em runtime.**
  Não existe captura para alimentá-los, e um `capture.json` escrito à mão seria um
  seed que nunca passou pelo produto — deliberadamente não foi fabricado.
- **Render Remotion de ponta a ponta.** Nenhum MP4 foi produzido até aqui.
- **Throughput do screencast a 30fps/1080p** — segue sendo o principal risco técnico
  da abordagem escolhida, e precisa de medição antes de a implementação depender dele.
- **Paridade com a CI.** A CI fixa Node 22 em `ubuntu-latest`; tudo acima foi
  observado em Node 26 / macOS 13. Os erros de typecheck são independentes de
  plataforma e falhariam na CI também; o de Playwright é específico do macOS 13.

## 9. Compositor: HyperFrames substitui o Remotion (decidido em 2026-09-10)

### Por que

O Remotion **não inicia** nesta máquina: seus binários de compositor são
compilados para macOS 15 e o host é 13.7.8. O pin mais recente que roda aqui é
4.0.437, ~86 versões atrás.

O HyperFrames (`hyperframes`, Apache-2.0) não tem binário nativo próprio — dirige
um Chrome x86_64 via puppeteer. Renderiza 9s de 1080p30 em 24 segundos nesta
mesma máquina.

Medido por execução, em dois spikes:

| Propriedade | Resultado |
|---|---|
| Seek frame-exato | 1:1 com a fonte em 8 timestamps, lidos no relógio do fixture |
| Determinismo | dois renders, SHA-256 idêntico |
| Composição > vídeo | segura o último frame |
| Corte | pulo no frame exato; faixa excluída presente no controle, ausente no corte |
| Rampa de velocidade | frame *n* = frame *2n* do controle, 5/5 |
| Callout posicionado | dentro de meio pixel do alvo |
| Razão de aspecto | marcadores 108×108 quadrados, contra 108×90 do Remotion |

### A licença, e por que ela pesa num OSS

O Remotion exige licença comercial paga acima de 3 pessoas na empresa. Num projeto
open-source isso não custa ao autor — **custa a quem adota**. Um time de produto
que queira usar o DemoMotion precisaria comprar licença de terceiro para rodar uma
ferramenta gratuita. Apache-2.0 elimina o pedágio.

(Este projeto **não** é um SaaS, apesar das seções 48 e 49 do documento de visão
original. O argumento de licença vale pela adoção, não por receita.)

### A armadilha que precisa virar asserção

Um clipe de vídeo cujo `data-duration` seja igual à duração da **mídia**, dentro de
uma composição mais longa, faz a cauda ir a **preto silenciosamente** — sem erro,
sem aviso, render sai 0. Medido: `blackdetect` acusou `black_duration:1.1`.

Regra: o `data-duration` do clipe é a duração da **composição**, não da mídia.
Com isso o engine trava no último frame decodificável e segura.

Isso vira teste com as duas metades: provar que o autoramento errado **aciona** o
`blackdetect`, e que o nosso não. Sem a metade positiva, a asserção é vazia.

### Encaixe com a EditList

`data-playback-rate` aceita velocidade **constante** por clipe. A `EditList` do §3 é
exatamente um `speed` constante por segmento. Rampas aceleradas não são suportadas
pelo engine — e a spec nunca as pediu.

### Telemetria

O `hyperframes` envia telemetria anônima de render para a HeyGen. O DemoMotion
define `HYPERFRAMES_NO_TELEMETRY` por padrão no processo de render: uma ferramenta
open-source não telefona para casa em nome de quem a instalou. Overridável por
quem quiser contribuir com dados, e documentado no README.

### O que ainda não foi provado

- Zoom combinado com corte (foram provados separadamente, nunca juntos)
- Áudio sob rampa de velocidade
- fps diferente de 30; composições aninhadas
- Determinismo entre máquinas diferentes

O Remotion permanece no repositório até o substituto cobrir tudo que ele cobria.
