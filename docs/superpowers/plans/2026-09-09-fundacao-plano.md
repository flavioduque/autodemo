# Plano de implementação — fundação DemoMotion v1

Spec: `docs/superpowers/specs/2026-09-09-demomotion-foundation-design.md`
Branch: `feat/fundacao-verificada`

## Regra de execução

Cada fase segue o ciclo do projeto: escrever o teste, **vê-lo falhar**, corrigir
com o mínimo, vê-lo passar, commitar os dois juntos. Uma fatia por vez. Nenhuma
fase é commitada sem que sua checklist de verificação passe por **execução**.

Ao concluir cada fase, o limite de cada prova é declarado na própria linha:
verificado por execução, por leitura de código, ou por consulta ao catálogo.

## O truque de verificação que sustenta todo o plano

A sincronia evento↔frame não pode ser verificada com o nosso próprio relógio —
seria valor esperado calculado pela mesma via que o código, e o teste passaria por
construção sem nunca discordar dele.

Por isso o app-fixture (fase 0) exibe na tela um **carimbo de tempo próprio**,
grande e legível: um contador que avança com `performance.now()` da própria página.

O teste de sincronia então lê o número **impresso no pixel do frame capturado** e
compara com o `sourceMs` que o adapter afirma para aquele frame. A fonte da verdade
é a página-alvo, independente do nosso relógio e do nosso código. Se o adapter
mentir sobre o tempo, o número no pixel discorda — e o teste fica vermelho.

Esse fixture é também o alvo de captura de todos os testes de ponta a ponta, o que
satisfaz a regra de que o dado de teste vem pelo produto: a captura é exercitada
operando um app real, servido localmente, nunca com `capture.json` escrito à mão.

---

## Fase 0 — Chão verificado

**Objetivo:** saber o que funciona hoje, por execução, e ter um alvo de testes.

- [x] Registrar o resultado real de `pnpm install`, `typecheck`, `test`, `build`
- [x] Confirmar contra `node_modules` a API real de `@modelcontextprotocol/server@2.0.0`
      (assinatura de `registerTool`, existência de `serveStdio`) e corrigir
      `apps/mcp-server/src/index.ts` se divergir
- [x] Remover `scripts-validate.mjs` (duplicata) e o caminho absoluto morto em
      `scripts/offline-core-test.mjs`
- [ ] Criar `fixtures/target-app/` — app local mínimo com carimbo de tempo visível,
      um formulário e uma lista, servido por um comando do repositório
- [x] Commitar `pnpm-lock.yaml`; CI passa a usar `--frozen-lockfile`

**Verificação:** o servidor MCP sobe e responde a um `tools/list`; o fixture serve
em `localhost`; um MP4 é produzido de ponta a ponta **ou** está documentado por
execução exatamente onde e por que falha.

### Fase 0 — o que já está fechado (verificado por execução, commit 05a0b52)

- A camada MCP **não** precisava de reescrita: `registerTool` aceita `z.object(...)`
  e essa é a forma preferida. O servidor sobe e responde `tools/list` com 15 tools.
- `typecheck`, `test` e `build` passaram de vermelho a 0, com `--no-bail` para que
  nenhum projeto abaixo do primeiro que falha seja mascarado.
- `noEmitOnError` ligado: build que falha não emite mais `dist/`.
- Captura destravada no macOS 13 via `DEMOMOTION_BROWSER_CHANNEL=chrome`.
- Uma armadilha registrada: adicionar a extensão `.js` exigida pelo NodeNext deixava
  o typecheck verde e **quebrava o bundler do Remotion**, que não aplica
  `extensionAlias`. Corrigido em `apps/studio/remotion.config.ts`. É o caso exemplar
  de por que a metade positiva do teste não é opcional.

Restam da fase 0: o app-fixture e o primeiro MP4 real.

## Fase 1 — Camada de tempo (EditList)

**Objetivo:** eliminar a classe de bug "feature de corte que não faz nada".

- [ ] `packages/core/src/editlist.ts`: `outputToSource`, `sourceToOutput`,
      `totalOutputMs`, `isCut`
- [ ] Schema: remover `trims`, introduzir `editList`
- [ ] Testes com valores calculados **à mão** e escritos na spec, não recalculados
      pela função sob teste

**Verificação:** as duas metades de cada teste — o trecho pedido some **e** o
material fora do corte permanece íntegro e na posição certa. Um corte no meio
desloca corretamente um zoom posterior.

## Fase 2 — Adapter de captura determinístico

**Objetivo:** tornar o mapa evento↔frame exato por construção.

- [ ] Interface `CaptureAdapter` conforme §4 da spec
- [ ] `PlaywrightScreencastAdapter` — loop CDP, grade de fps constante
- [ ] **Medir throughput a 30fps/1080p antes de depender dele.** É o principal
      risco técnico; se a captura deformar o que a demo mostra, a spec muda aqui
- [ ] Cursor comandado (`page.mouse.move` em passos), trilha registrada

**Verificação:** o teste do carimbo de tempo — ler o número no pixel do frame `i`
e conferir contra `i / fps * 1000`, dentro de uma tolerância declarada.

## Fase 3 — Câmera e composição

- [ ] Retângulo de câmera em coordenadas normalizadas da fonte
- [ ] Corrigir `objectFit: "cover"` — todo corte passa a ser explícito
- [ ] Easing real; retângulo limitado às bordas
- [ ] Composição passa a ler a EditList

**Verificação:** renderizar frames específicos e inspecionar o pixel. Provar que o
frame do produto **não** está cortado: semear um marcador nas quatro bordas do
fixture e confirmar que os quatro aparecem quando não há zoom.

## Fase 4 — Cursor sintético

- [ ] Camada de cursor no Remotion: suavização, pulso de clique
- [ ] Ancorado em `sourceMs`, projetado pela EditList

**Verificação:** no frame de um clique, o cursor está sobre o elemento clicado —
conferido contra o *bounding box* que a captura registrou.

## Fase 5 — Legendas script-first

- [ ] Legendas ancoradas em `sourceMs`, sem transcrição e sem API key
- [ ] Safe area compartilhada com callouts

**Verificação:** legenda visível no intervalo correto após um corte que a antecede.

## Fase 6 — Endurecimento da superfície MCP

- [ ] Allowlist aplicada a **toda** navegação, inclusive redirects e navegação
      disparada por clique — não só em `goto`
- [ ] Caminhos absolutos: nada resolvido contra `cwd`
- [ ] Timeout e cleanup de sessão; browsers não vazam
- [ ] Isolamento de filesystem para saída

**Verificação:** cada guarda tem teste com as duas metades — o abuso é recusado
**e** o uso legítimo continua passando. Conferir **quem** recusou: a mensagem tem
que ser a da nossa regra, não um erro genérico do Playwright.

## Fase 7 — CI, documentação e release

- [ ] CI renderiza um MP4 de verdade e falha se não render
- [ ] README reescrito contra o que foi verificado por execução
- [ ] `RELEASE_CHECKLIST.md` refeito, sem item marcado que não foi exercitado
- [ ] Cobertura relatada como fração e escopo; seção "não consegui verificar"

**Verificação:** um clone limpo, numa máquina sem estado prévio, chega ao MP4
seguindo apenas o README.
