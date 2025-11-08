const fs = require('fs');
const path = require('path');
const {minify} = require('terser');

async function build() {
    const sourceFile = path.join(__dirname, 'talk-to-me.js');
    const outputFile = path.join(__dirname, 'talk-to-me-chat.min.js');

    const code = fs.readFileSync(sourceFile, 'utf8');

    const result = await minify(code, {
        compress: {
            dead_code: true,
            drop_console: true,
            drop_debugger: true,
            keep_classnames: true,
            keep_fnames: false,
            passes: 2
        },
        mangle: {
          keep_classnames: true,
        },
        format: {
            comments: false,
            preamble: '/* TalkToMeChat SDK v1.0.0 | (c) 2025 */'
        }
    });

    fs.writeFileSync(outputFile, result.code);

  console.log('✅ Build completo!');
  console.log(`📦 Arquivo gerado: ${outputFile}`);
  console.log(`📊 Tamanho original: ${(code.length / 1024).toFixed(2)} KB`);
  console.log(`📊 Tamanho minificado: ${(result.code.length / 1024).toFixed(2)} KB`);
}

build().catch(console.error);