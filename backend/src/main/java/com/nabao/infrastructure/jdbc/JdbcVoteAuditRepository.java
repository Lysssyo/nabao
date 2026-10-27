package com.nabao.infrastructure.jdbc;
import com.nabao.application.ApplicationFailure;
import com.nabao.application.port.VoteAuditRepository;
import com.nabao.domain.VoteAuditModels.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
@Repository
public class JdbcVoteAuditRepository implements VoteAuditRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    public JdbcVoteAuditRepository(JdbcTemplate jdbc, ObjectMapper json) { this.jdbc=jdbc; this.json=json; }
    public String hash(String id) {
        var rows=jdbc.queryForList("SELECT payload_hash FROM vote_audit_batch WHERE batch_id=?",String.class,id);
        return rows.isEmpty()?null:rows.getFirst();
    }
    public void insert(Batch b, String hash) {
        jdbc.update("INSERT INTO vote_audit_batch (batch_id,data_date,recorded_at,rule_name,revision,publication_status,sources_json,entry_count,payload_hash) VALUES (?,?,?,?,?,?,?,?,?)",
                b.id(),b.dataDate(),Timestamp.from(b.recordedAt()),b.rule(),b.revision(),b.publicationStatus(),encode(b.sources()),b.entries().size(),hash);
        jdbc.batchUpdate("INSERT INTO vote_audit_entry (batch_id,entry_index,author_id,field_name,entry_json) VALUES (?,?,?,?,?)",java.util.stream.IntStream.range(0,b.entries().size()).boxed().toList(),200,
                (ps,index)->{ var e=b.entries().get(index); ps.setString(1,b.id());ps.setInt(2,index);ps.setString(3,e.authorId());ps.setString(4,e.field());ps.setString(5,encode(e)); });
    }
    private Summary summary(java.sql.ResultSet rs) throws java.sql.SQLException {
        List<Source> sources;
        try { sources=json.readValue(rs.getString("sources_json"),new TypeReference<List<Source>>(){}); }
        catch (Exception e) { throw new IllegalStateException("Invalid stored vote audit"); }
        return new Summary(rs.getString("batch_id"),rs.getDate("data_date").toLocalDate(),rs.getTimestamp("recorded_at").toInstant(),
                rs.getString("rule_name"),rs.getString("revision"),rs.getString("publication_status"),sources,rs.getLong("entry_count"));
    }
    public List<Summary> list() { return jdbc.query("SELECT * FROM vote_audit_batch ORDER BY recorded_at DESC,batch_id DESC LIMIT 50",(rs,n)->summary(rs)); }
    public List<Fund> funds(String id) {
        if (hash(id)==null) throw new ApplicationFailure(ApplicationFailure.Kind.NOT_FOUND,"Vote audit not found");
        var funds=new java.util.TreeMap<String,Fund>();
        jdbc.query("SELECT entry_json FROM vote_audit_entry WHERE batch_id=? ORDER BY entry_index",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> { var entry=decodeEntry(rs.getString(1)); funds.putIfAbsent(entry.fundCode(),new Fund(entry.fundCode(),entry.fundName())); },id);
        return List.copyOf(funds.values());
    }
    public Page entries(String id, String author, String field, String fundCode, int page) {
        var batches=jdbc.query("SELECT * FROM vote_audit_batch WHERE batch_id=?",(rs,n)->summary(rs),id);
        if(batches.isEmpty()) throw new ApplicationFailure(ApplicationFailure.Kind.NOT_FOUND,"没有此批次投票日志。");
        var args=new ArrayList<Object>();args.add(id);
        String where=" WHERE batch_id=?";
        if(author!=null) { where+=" AND author_id=?";args.add(author); }
        if(field!=null) { where+=" AND field_name=?";args.add(field); }
        if(fundCode!=null) { where+=" AND entry_json LIKE ?";args.add("%\"fundCode\":\""+fundCode+"\"%"); }
        long total=jdbc.queryForObject("SELECT COUNT(*) FROM vote_audit_entry"+where,Long.class,args.toArray());
        args.add(100);args.add(page*100);
        var entries=jdbc.query("SELECT entry_json FROM vote_audit_entry"+where+" ORDER BY entry_index LIMIT ? OFFSET ?",
                (rs,n)->decodeEntry(rs.getString(1)),args.toArray());
        return new Page(batches.getFirst(),total,page,100,entries);
    }
    private String encode(Object value) { try { return json.writeValueAsString(value); } catch(Exception e) {throw new IllegalStateException("Cannot encode vote audit");} }
    private Entry decodeEntry(String text) {try{return json.readValue(text,Entry.class);}catch(Exception e){throw new IllegalStateException("Invalid stored vote audit");}}
}
