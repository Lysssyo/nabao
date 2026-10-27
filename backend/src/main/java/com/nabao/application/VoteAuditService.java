package com.nabao.application;
import com.nabao.application.port.VoteAuditRepository;
import com.nabao.domain.VoteAuditModels.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.List;
@Service
public class VoteAuditService {
    private final VoteAuditRepository repository;
    private final ObjectMapper json;
    public VoteAuditService(VoteAuditRepository repository, ObjectMapper json) { this.repository=repository; this.json=json; }
    @Transactional public void record(Batch batch) {
        var authors = new HashSet<String>();
        for (var source : batch.sources()) if (!authors.add(source.authorId())) invalid();
        for (var entry : batch.entries()) {
            if (!authors.contains(entry.authorId()) || !entry.sourceDate().equals(batch.dataDate()) && !entry.ballotStatus().equals("OTHER_DATE")
                    || !entry.sourceUrl().endsWith("/"+entry.noteId())) invalid();
        }
        String hash;
        try { hash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(batch))); }
        catch (Exception error) { throw new ApplicationFailure(ApplicationFailure.Kind.UNAVAILABLE,"无法保存投票日志。"); }
        String existing=repository.hash(batch.id());
        if (existing != null) {
            if (!existing.equals(hash)) throw new ApplicationFailure(ApplicationFailure.Kind.CONFLICT,"相同批次的日志不可改写。");
            return;
        }
        repository.insert(batch, hash);
    }
    public List<Summary> list() { return repository.list(); }
    public List<Fund> funds(String id) {
        validateId(id);return repository.funds(id);
    }
    private static void validateId(String id) { if(!id.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) invalid(); }
    public Page entries(String id, String author, String field, String fundCode, int page) {
        if (!id.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") || page<0 || page>10000
                || fundCode!=null && !fundCode.matches("[0-9]{6}")
                || author!=null && !author.matches("[a-f0-9]{24}")
                || field!=null && !List.of("feeRate","distributorLimit","directLimit","trackingError","return1y").contains(field)) invalid();
        return repository.entries(id, author, field, fundCode, page);
    }
    private static void invalid() { throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT,"投票日志参数无效。"); }
}
