# aos-verify

Workflow reutilizable de AOS: mide el gate (`aos/verify.json`) en el repo del dev y pide a aos-api un recibo firmado.
El rojo también se firma. Si un PR cambia `aos/verify.json`, se mide con la definición de la rama base.

Un repo de cliente lo invoca con `.github/workflows/aos-verify.yml`:

```yaml
name: aos-verify
on: [pull_request, push]
permissions:
  id-token: write
  contents: read
jobs:
  verify:
    uses: AG-0xAi/aos-verify/.github/workflows/verify.yml@v1
    with: { api-url: 'https://api.aos.example', audience: 'https://api.aos.example' }
```

Fuente en `deploy/aos-verify/` del monorepo; el coordinador la publica en `AG-0xAi/aos-verify` con la etiqueta `v1`.
Antes de publicar, verifica que el sha fijado de `actions/setup-node` corresponde a su tag.
