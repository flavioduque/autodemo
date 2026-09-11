# Fixture: showcase-app

**Saltmarsh**, um produto de faturamento fictício para estúdios que cobram por
projeto. Existe para ser **gravado**: é a aplicação bonita que aparece no vídeo
de demonstração do topo do README do projeto.

Não confundir com `fixtures/target-app`. Aquele é o alvo dos testes de captura e
carrega instrumentos de depuração (marcadores de canto, relógio de milissegundos)
de propósito. Este aqui **não tem nenhum instrumento**: nada de relógio, nada de
marcador, nada de andaime de teste visível.

Saltmarsh não imita nenhuma empresa real. Nome, clientes, números e depoimento
são inventados, e o rodapé diz isso na própria página.

## Como servir

```bash
pnpm showcase         # a partir da raiz do repositório
```

Sobe em **http://127.0.0.1:4322** (porta fixa; sobrescreva com `SHOWCASE_PORT`).
A 4322 foi escolhida para não colidir com a 4321 do `target-app`: os dois podem
rodar ao mesmo tempo.

## Restrições que a gravação impõe

- **Zero requisições externas.** Nenhuma fonte de CDN, nenhuma imagem remota. A
  tipografia é a pilha do sistema (SF Pro no macOS), os gráficos são CSS e os
  poucos ícones são SVG inline. A página renderiza idêntica offline.
- **Zero dependências.** HTML, CSS e JS puros, sem etapa de build.
- **Tema travado no escuro**, um único acento âmbar, uma única escala de raio
  (999px para pílulas de status, 10px para controles, 16px para cartões).
- **Movimento discreto e respeitando `prefers-reduced-motion`**: entrada do herói
  por cascata de `animation-delay` e revelação por `IntersectionObserver`.

## Rotas

| Rota       | O que serve                                                        |
| ---------- | ------------------------------------------------------------------ |
| `/`        | Landing: herói, faixa de números, bento de recursos, depoimento.    |
| `/signup`  | Formulário de criação de conta; o sucesso acontece na mesma página. |
| `/signup/` | Mesmo arquivo (barra final aceita).                                 |

Qualquer outro caminho responde 404 em texto puro.

## O roteiro da demonstração

1. Abrir `/` e descer devagar pela página.
2. Clicar em **Start free** (`hero-cta-primary`) para ir a `/signup`.
3. Preencher nome, e-mail e senha. **A senha é o momento que rende no vídeo**: o
   medidor de força tem quatro segmentos e reage a cada caractere digitado, e a
   dica ao lado do rótulo diz o que falta ("3 to go", "add a symbol").
4. Marcar os termos e clicar em **Create workspace** (`signup-submit`).
5. O botão vira "Creating workspace" e, após ~650 ms, o formulário dá lugar ao
   painel de sucesso: o primeiro nome digitado aparece no título e vira o slug da
   URL do workspace.

O painel de sucesso cabe inteiro numa janela de 900px de altura, para que o
clímax não precise de rolagem.

## Seletores estáveis

Todo elemento interativo tem `data-testid`.

### Landing (`/`)

| `data-testid`            | Elemento                                     |
| ------------------------ | -------------------------------------------- |
| `nav-logo`               | marca no topo, link para `/`                 |
| `nav-link-product`       | link "Product" (âncora `#features`)          |
| `nav-link-customers`     | link "Customers" (âncora `#customers`)       |
| `nav-signin`             | link "Sign in"                               |
| `nav-cta`                | botão "Start free" do topo                   |
| `hero-cta-primary`       | botão "Start free" do herói (vai a `/signup`)|
| `hero-cta-secondary`     | botão "See how it works"                     |
| `hero-panel`             | painel de faturas do herói (não interativo)  |
| `footer-logo`            | marca no rodapé                              |
| `footer-link-product`    | link "Product" do rodapé                     |
| `footer-link-customers`  | link "Customers" do rodapé                   |
| `footer-cta`             | link "Start free" do rodapé                  |

### Cadastro (`/signup`)

| `data-testid`              | Elemento                                        |
| -------------------------- | ----------------------------------------------- |
| `signup-back`              | marca no topo, volta para `/`                   |
| `signup-nav-home`          | link "Back to site"                             |
| `signup-card`              | o cartão inteiro (formulário e sucesso)         |
| `signup-form`              | o `<form>`                                      |
| `signup-name-input`        | campo nome completo                             |
| `signup-email-input`       | campo e-mail                                    |
| `signup-password-input`    | campo senha                                     |
| `signup-password-toggle`   | botão "Show"/"Hide"                             |
| `password-strength`        | medidor; `data-score` vai de `0` a `4`          |
| `password-strength-label`  | rótulo textual da força                         |
| `password-strength-tip`    | dica do que falta para subir de nível           |
| `signup-terms-checkbox`    | caixa de aceite dos termos                      |
| `signup-terms-link`        | link "terms of service"                         |
| `signup-submit`            | botão "Create workspace"                        |
| `signup-name-error`        | erro em linha do nome                           |
| `signup-email-error`       | erro em linha do e-mail                         |
| `signup-password-error`    | erro em linha da senha                          |
| `signup-terms-error`       | erro em linha dos termos                        |

### Sucesso (mesma rota, depois do envio)

| `data-testid`             | Elemento                                         |
| ------------------------- | ------------------------------------------------ |
| `success-panel`           | o painel de sucesso inteiro                      |
| `success-headline`        | "Workspace ready, `<primeiro nome>`."            |
| `success-workspace-name`  | `saltmarsh.app/<slug>`                           |
| `success-panel-ledger`    | vislumbre do razão com três rascunhos            |
| `success-cta`             | botão "Open workspace"                           |

`success-panel` começa com o atributo `hidden`; `signup-form` recebe `hidden`
quando o sucesso aparece. Espere por visibilidade, não por presença no DOM.

## Regras de validação

O envio é recusado enquanto: o nome tiver menos de 2 caracteres, o e-mail não
casar com `algo@algo.tld`, a força da senha for menor que 2, ou os termos não
estiverem marcados. Cada recusa escreve no `*-error` correspondente e marca o
campo com a classe `invalid`. O painel de sucesso não aparece.

A força da senha é `0` vazia, `1` abaixo de 6 caracteres, e daí sobe contando
comprimento (10 e 14), maiúscula com minúscula, dígito e símbolo.
