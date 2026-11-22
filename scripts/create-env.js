// Crea .env con un par VAPID nuevo y un token de administrador. Nunca sobrescribe uno existente.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';

if (existsSync('.env')) {
  console.error('.env ya existe: no se modifica. Bórralo si de verdad quieres claves nuevas.');
  process.exit(1);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
writeFileSync(
  '.env',
  [
    'PORT=3000',
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${privateKey}`,
    '# Contacto que exige el protocolo: mailto:tu-correo o la URL https de tu app.',
    'VAPID_SUBJECT=https://example.com',
    `ADMIN_TOKEN=${randomBytes(24).toString('hex')}`,
    '# Orígenes permitidos, separados por comas.',
    'ALLOWED_ORIGINS=http://localhost:8081,http://127.0.0.1:8081,http://localhost:4200',
    '',
  ].join('\n'),
);
console.log(`.env creado.\nClave pública VAPID:\n${publicKey}`);
