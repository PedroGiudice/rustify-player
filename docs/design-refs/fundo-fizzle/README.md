# Esboços de fundo no Fizzle (11/10/2026)

O [Fizzle](https://fizzle.glossing.dev) é um ambiente de live coding de
visuais no navegador (three.js + WebGL2), do Glossing. O código dele é
fechado; o que se aproveita é o shader que escrevemos dentro do `glsl(...)`,
que é GLSL padrão e vai para o app quase igual.

Regra dos esboços: o desenho inteiro dentro do `glsl(...)`, sem os efeitos
prontos do Fizzle (feedback, bloom, kaleido), porque esses não existem no app.

| Arquivo | Virou | Estado |
|---|---|---|
| `tinta.fizzle.js` | `src/gl/scenes/paint.ts` (Tinta) | aprovado pelo CEO |
| `riso.fizzle.js` | `src/gl/scenes/riso.ts` (Riso) | aprovado pelo CEO |

Reprovados na mesma sessão (não reoferecer variante): moiré de anéis
concêntricos ("hipnótico"), retícula de pontos ("tripofobia"), fitas
onduladas ("genérico"). Causa comum dos dois primeiros: muitos elementos
pequenos, iguais e de alto contraste.

Diferenças do porte: no app, a reação ao som é RELATIVA à faixa
(`swell`/`pulse`/`midLift` de `src/gl/signal.ts`), não o nível absoluto do
Fizzle; as cores vêm da paleta do app (tema e capa), não dos hex fixos.

Abrir um esboço no Fizzle:

```bash
python3 docs/design-refs/fundo-fizzle/fizzle_link.py docs/design-refs/fundo-fizzle/tinta.fizzle.js
```
