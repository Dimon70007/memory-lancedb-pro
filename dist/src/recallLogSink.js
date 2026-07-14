export class LanceDbRecallLogSink {
    table;
    constructor(table) {
        this.table = table;
    }
    async logBatch(entries) {
        if (!entries.length)
            return;
        await this.table.add(entries);
    }
}
