package com.nabao.application.port;
import com.nabao.domain.VoteAuditModels.*;
import java.util.List;
public interface VoteAuditRepository {
    String hash(String id);
    void insert(Batch batch, String hash);
    List<Summary> list();
    List<Fund> funds(String id);
    Page entries(String id, String authorId, String field, String fundCode, int page);
}
