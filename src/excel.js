const fs = require("fs");
const ExcelJS = require("exceljs");

function normalizePhone(raw) {
    if (raw === null || raw === undefined) {
        return "";
    }

    const phone = String(raw).trim();
    return phone.replace(/[^0-9]/g, "");
}

function detectPhoneColumn(row) {
    const keys = Object.keys(row || {});
    const candidates = ["phone", "telefono", "tel", "mobile", "celular", "numero", "numero_telefono"];

    for (const key of keys) {
        const lowered = key.toLowerCase().replace(/\s+/g, "_");
        if (candidates.includes(lowered)) {
            return key;
        }
    }

    return keys[0] || null;
}

function getCellValue(cell) {
    if (!cell) {
        return "";
    }

    if (cell.value && typeof cell.value === "object" && "text" in cell.value) {
        return cell.value.text || "";
    }

    return cell.text !== undefined ? cell.text : cell.value;
}

async function parseExcelRecipients({ filePath, buffer, sheetName, phoneColumn }) {
    const workbook = new ExcelJS.Workbook();

    if (buffer) {
        await workbook.xlsx.load(buffer);
    } else if (filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`No existe el archivo: ${filePath}`);
        }
        await workbook.xlsx.readFile(filePath);
    } else {
        throw new Error("Debes enviar filePath o buffer para procesar Excel.");
    }

    const worksheet = sheetName
        ? workbook.getWorksheet(sheetName)
        : workbook.worksheets[0];

    if (!worksheet) {
        throw new Error(`No existe la hoja: ${sheetName || "(primera hoja)"}`);
    }

    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const header = String(getCellValue(cell) || `column_${colNumber}`).trim();
        headers[colNumber - 1] = header;
    });

    const rows = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const excelRow = worksheet.getRow(rowNumber);
        const rowObj = {};
        let hasAnyValue = false;

        headers.forEach((header, index) => {
            const value = getCellValue(excelRow.getCell(index + 1));
            rowObj[header] = value;
            if (String(value || "").trim() !== "") {
                hasAnyValue = true;
            }
        });

        if (hasAnyValue) {
            rows.push(rowObj);
        }
    }

    if (rows.length === 0) {
        return [];
    }

    const resolvedPhoneColumn = phoneColumn || detectPhoneColumn(rows[0]);

    if (!resolvedPhoneColumn) {
        throw new Error("No se encontro columna de telefono en el Excel.");
    }

    return rows
        .map((row) => {
            const to = normalizePhone(row[resolvedPhoneColumn]);
            return {
                to,
                row,
            };
        })
        .filter((entry) => entry.to);
}

module.exports = {
    parseExcelRecipients,
};
