/**
 * ESP32 SIMULYATORI — qurilmasiz test qilish uchun.
 *
 * Bazadagi qurilmalarni o'qiydi va ularning nomidan `POST /api/data`
 * ga harorat yuboradi. Shu tufayli butun oqimni (kalit tekshiruvi →
 * o'lchov yozish → holat hisoblash → ogohlantirish → WebSocket)
 * birorta temir qurilmasiz tekshirib ko'rish mumkin.
 *
 * ⚠️ Kalit BAZADAN O'QILMAYDI — u yerda faqat hash bor. Shuning
 * uchun simulyator `--key` bilan beriladigan BITTA kalitdan
 * foydalanadi (seed'dagi `modul1` kaliti) yoki `--all` rejimida
 * kalitni muhit o'zgaruvchisidan oladi. Aks holda simulyator
 * kalitlarni ochiq saqlashni talab qilardi va bu butun himoyani
 * ma'nosiz qilardi.
 *
 * Ishlatish:
 *   npm run simulate -- --device modul1 --key 91abcc... --temp 54
 *   npm run simulate -- --device modul1 --key 91abcc... --loop 10
 */
import { config as loadEnv } from 'dotenv';

loadEnv();

interface Options {
  device: string;
  key: string;
  url: string;
  temp: number | null;
  loop: number;
  intervalMs: number;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const port = process.env.PORT ?? '3000';

  return {
    device: read('device') ?? 'modul1',
    key: read('key') ?? process.env.SIMULATE_API_KEY ?? '',
    url: read('url') ?? `http://localhost:${port}/api/data`,
    temp: read('temp') ? Number(read('temp')) : null,
    loop: read('loop') ? Number(read('loop')) : 1,
    intervalMs: read('interval') ? Number(read('interval')) * 1000 : 3000,
  };
}

/**
 * ⚠️ Harorat TASODIFIY sakramaydi, balki 55 °C atrofida sekin
 * tebranadi. Butunlay tasodifiy qiymat har signalda kotyol holatini
 * o'zgartirib, WebSocket'ni xabar bilan to'ldirardi — ya'ni
 * simulyator o'zi sinamoqchi bo'lgan narsani buzardi.
 */
function nextTemperature(previous: number): number {
  const drift = (Math.random() - 0.5) * 2.4;
  const value = previous + drift;
  return Math.round(Math.min(92, Math.max(12, value)) * 100) / 100;
}

async function main(): Promise<void> {
  const options = parseArgs();

  if (!options.key) {
    console.error(
      '✖ API kalit berilmagan.\n' +
        '  Ishlatish: npm run simulate -- --device modul1 --key <kalit>\n' +
        '  Yoki muhitga qo‘ying: SIMULATE_API_KEY=<kalit>',
    );
    process.exit(1);
  }

  console.log(`▶ ${options.url}`);
  console.log(`  qurilma: ${options.device}, signallar: ${options.loop}`);

  let temperature = options.temp ?? 55;

  for (let index = 0; index < options.loop; index += 1) {
    if (options.temp === null && index > 0) {
      temperature = nextTemperature(temperature);
    }

    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': options.key,
        },
        body: JSON.stringify({
          deviceId: options.device,
          temperature,
          firmware: '1.0.0-sim',
          // ⚠️ Ortiqcha maydonlar ATAYLAB yuboriladi: server ularni
          // rad etmasligi va `raw_payload` ga saqlashi kerak
          // (`ingest.controller.ts` dagi izohga qarang).
          rssi: -62,
          uptime: 3600 + index * 30,
        }),
      });

      const text = await response.text();
      const stamp = new Date().toISOString().slice(11, 19);
      console.log(
        `  ${stamp}  ${temperature.toFixed(1)} °C → ${response.status} ${text}`,
      );
    } catch (error) {
      console.error(
        '  ✖ Yuborib bo‘lmadi:',
        error instanceof Error ? error.message : String(error),
      );
    }

    if (index < options.loop - 1) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }
}

void main();
