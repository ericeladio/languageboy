<div align="center">

<img width="220" src="docs/Logo-light.png#gh-dark-mode-only" alt="LanguageBoy">
<img width="220" src="docs/Logo.png#gh-light-mode-only" alt="LanguageBoy">

<h1>LanguageBoy</h1>

Emulador para jugar y traducir juegos de **GBA** y **NDS**.

[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=for-the-badge&logo=opensourceinitiative)](LICENSE)
[![Demo](https://img.shields.io/badge/Demo-528116?style=for-the-badge)](https://languageboy.vercel.app)

</div>

---

## Características

- Traducción de texto en vivo mientras juegas.
- Guarda tus palabras favoritas.
- Exporta tus favoritas como tarjetas **Anki**.
- Soporte para ROMs de **GBA** y **NDS**.

## Uso

Abre [languageboy.vercel.app](https://languageboy.vercel.app), arrastra tu ROM y empieza a jugar.

## Desarrollo

```sh
npm install
npm start
```

La demo queda disponible en `http://localhost:8080/`.

## Créditos

LanguageBoy está construido sobre [EmulatorJS](https://emulatorjs.org/), el motor de emulación en JavaScript que hace posible ejecutar los juegos en el navegador.

La traducción se ejecuta localmente en el navegador gracias a [runonweb](https://runonweb.ai/), el proyecto de IA en el navegador de [midudev](https://midu.dev/).

## Licencia

Distribuido bajo la licencia [GPLv3](LICENSE).
