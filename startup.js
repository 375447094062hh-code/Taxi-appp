const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";

function injectAddressAutocomplete() {
    try {
        const indexPath = path.join(__dirname, "public", "index.html");

        if (!fs.existsSync(indexPath)) {
            return;
        }

        let html = fs.readFileSync(indexPath, "utf8");

        if (html.includes("/address-autocomplete.js")) {
            return;
        }

        const script = '\n<script src="/address-autocomplete.js"></script>\n';
        const marker = "</body>";

        if (html.includes(marker)) {
            html = html.replace(marker, script + marker);
            fs.writeFileSync(indexPath, html, "utf8");
            console.log("Автоподсказки адресов подключены.");
        }
    } catch (error) {
        console.error("Ошибка подключения автоподсказок адресов:", error.message);
    }
}

async function migrate() {
    if (!DATABASE_URL) {
        console.log("DATABASE_URL не задан — пропускаем миграцию.");
        return;
    }

    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        // Telegram ID храним как TEXT.
        const columns = [
            ["passengers", "telegram_id"],
            ["drivers", "telegram_id"],
            ["passenger_orders", "id"],
            ["passenger_orders", "telegram_user_id"],
            ["passenger_orders", "driver_telegram_id"]
        ];

        for (const [table, column] of columns) {
            const result = await pool.query(
                `
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = $1
                  AND column_name = $2
                `,
                [table, column]
            );

            if (!result.rows.length) continue;

            if (result.rows[0].data_type !== "text") {
                console.log(`Исправляем ${table}.${column}: ${result.rows[0].data_type} -> text`);
                await pool.query(
                    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TEXT USING ${column}::text`
                );
            }
        }

        // В старой базе мог остаться telegram_id с NOT NULL.
        // Новый server.js использует telegram_user_id.
        // Переносим старые значения и убираем обязательность старого поля,
        // чтобы старое ограничение больше не ломало создание заказа.
        const legacyColumn = await pool.query(`
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'passenger_orders'
              AND column_name = 'telegram_id'
        `);

        const currentColumn = await pool.query(`
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'passenger_orders'
              AND column_name = 'telegram_user_id'
        `);

        if (legacyColumn.rows.length && currentColumn.rows.length) {
            await pool.query(`
                UPDATE passenger_orders
                SET telegram_user_id = telegram_id
                WHERE telegram_user_id IS NULL
                  AND telegram_id IS NOT NULL
            `);

            await pool.query(`
                ALTER TABLE passenger_orders
                ALTER COLUMN telegram_id DROP NOT NULL
            `);

            console.log("Старая колонка passenger_orders.telegram_id исправлена.");
        }

        console.log("Проверка типов PostgreSQL завершена.");
    } finally {
        await pool.end();
    }
}

injectAddressAutocomplete();

migrate()
    .then(() => {
        require("./server.js");
    })
    .catch((error) => {
        console.error("Ошибка миграции PostgreSQL:", error);
        process.exit(1);
    });
