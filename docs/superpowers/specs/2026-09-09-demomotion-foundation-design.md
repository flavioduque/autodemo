# DemoMotion — Design de fundação (v1 OSS)

Data: 2026-09-09
Status: proposto, aguardando revisão
Escopo: sub-projetos 0 e 1 (fundação verificada + qualidade cinematográfica)

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

## 8. O que permanece não verificado

Esta seção existe para não criar confiança falsa e será atualizada com o resultado
do levantamento em execução:

- Se as dependências fixadas instalam e resolvem juntas.
- Se a API do `@modelcontextprotocol/server@2.0.0` usada em
  `apps/mcp-server/src/index.ts` corresponde à do pacote publicado — em especial
  se `registerTool` aceita `z.object(...)` ou uma shape crua, e se o subpath
  `stdio` exporta `serveStdio`.
- Se o Remotion renderiza um MP4 nesta máquina.
- Throughput real do screencast a 30fps/1080p, e quanto ele deforma o que a demo
  mostra. **É o principal risco técnico da abordagem escolhida** e precisa de uma
  medição antes de a implementação depender dela.
