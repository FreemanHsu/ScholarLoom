CREATE UNIQUE INDEX uq_index_outbox_source_operation ON index_outbox(projection,source_id,operation);
