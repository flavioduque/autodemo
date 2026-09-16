# Fixture: target-app

Aplicação web mínima, sem dependências, que faz o papel do "SaaS de um cliente"
nos testes de captura e render do AutoDemo.

## Como servir

```bash
pnpm fixture          # a partir da raiz do repositório
```

Sobe em **http://127.0.0.1:4321** (porta fixa; sobrescreva com `FIXTURE_PORT`).

## Rotas

| Rota        | O que serve                                                        |
| ----------- | ------------------------------------------------------------------ |
| `/`         | O CRM direto, num único frame.                                     |
| `/embedded` | Uma página hospedeira cujo conteúdo é o MESMO CRM dentro de um `<iframe>`. |

`/embedded` reproduz o formato do site real que expôs a cegueira a iframes: o
documento hospedeiro só tem um banner de cookies (três controles) e o produto
inteiro vive um frame abaixo. O iframe é deliberadamente deslocado da origem
(48px de trilho à esquerda, 72px de banner no topo) — um iframe colado em 0,0
tornaria qualquer asserção de coordenada vazia, porque coordenada relativa ao
frame e relativa ao viewport seriam o mesmo número.

## O que a página oferece

- **Carimbo de tempo decorrido** (`data-testid="elapsed-clock"`): dígitos grandes,
  monoespaçados, verde sobre preto, no formato `T+01234 ms`. O número vem do
  `performance.now()` da própria página e é atualizado a cada animation frame.
  Serve como oráculo independente: o valor lido de um frame capturado pode ser
  comparado com o timestamp que o adaptador de captura afirma.
- **Marcadores nos quatro cantos** (`corner-tl`, `corner-tr`, `corner-bl`,
  `corner-br`): quadrados de 128px colados às bordas do viewport, com cores e
  rótulos distintos. Se o render cortar a gravação, pelo menos um desaparece.
- **Fluxo demonstrável**: botão "New client" abre o formulário (nome, e-mail,
  telefone), "Save client" adiciona uma linha na lista, incrementa o contador e
  mostra a mensagem de sucesso.

## Seletores estáveis

| `data-testid`          | Elemento                         |
| ---------------------- | -------------------------------- |
| `new-client-button`    | abre o formulário                |
| `client-name-input`    | campo nome                       |
| `client-email-input`   | campo e-mail                     |
| `client-phone-input`   | campo telefone                   |
| `save-button`          | salva o cliente                  |
| `cancel-button`        | fecha o formulário               |
| `client-list`          | lista de clientes                |
| `client-row`           | cada linha da lista              |
| `client-count`         | contador de clientes             |
| `success-message`      | mensagem de sucesso              |
| `elapsed-clock`        | carimbo de tempo                 |
| `corner-tl/tr/bl/br`   | marcadores de canto              |

### Só em `/embedded` (frame hospedeiro)

| `data-testid`          | Elemento                         |
| ---------------------- | -------------------------------- |
| `host-cookie-banner`   | banner de cookies do hospedeiro  |
| `host-cookie-accept`   | botão "Accept" (remove o banner) |
| `host-cookie-decline`  | botão "Decline" (remove o banner)|
| `host-privacy-link`    | link "Privacy policy"            |

O `<iframe>` em si é `#app-frame`.
