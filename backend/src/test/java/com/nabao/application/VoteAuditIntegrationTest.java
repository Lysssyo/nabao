package com.nabao.application;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.assertj.core.api.Assertions.*;
@SpringBootTest
@ActiveProfiles("test")
@AutoConfigureMockMvc
class VoteAuditIntegrationTest {
    @Autowired MockMvc http;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    static final String KEY="test-internal-key";
    static final String ID="12345678-1234-1234-1234-123456789012";
    @BeforeEach void clear(){jdbc.update("DELETE FROM vote_audit_entry");jdbc.update("DELETE FROM vote_audit_batch");}
    String payload() {return """
      {"id":"12345678-1234-1234-1234-123456789012","dataDate":"2026-10-27","recordedAt":"2026-10-27T14:00:00Z",
       "rule":"UNIQUE_PLURALITY_SINGLE_SOURCE_ALLOWED_PER_FIELD","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "publicationStatus":"PUBLISHED","sources":[{"authorId":"aaaaaaaaaaaaaaaaaaaaaaaa","name":"博主甲","status":"HAS_TABLE"}],
       "entries":[{"authorId":"aaaaaaaaaaaaaaaaaaaaaaaa","authorName":"博主甲","noteId":"bbbbbbbbbbbbbbbbbbbbbbbb",
       "sourceUrl":"https://www.xiaohongshu.com/explore/bbbbbbbbbbbbbbbbbbbbbbbb","sourceDate":"2026-10-27","capturedAt":"2026-10-27T13:00:00Z",
       "fundCode":"019441","fundName":"万家纳指A","field":"directLimit","rawValue":"100元/日","normalizedValue":"100",
       "voteKey":"[AMOUNT,100]","notes":["额度单位：元/日"],"ballotStatus":"COUNTED","decisionStatus":"ADOPTED","adoptedValue":"100","supportCount":1}]}
      """;}
    @Test void recordsOriginalValuesAndSupportsFiltersWithoutOverwritingRepeatedBatches() throws Exception {
        for(int i=0;i<2;i++) http.perform(post("/internal/v1/vote-audits").header("X-Internal-Key",KEY).contentType(MediaType.APPLICATION_JSON).content(payload())).andExpect(status().isNoContent());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM vote_audit_entry",Long.class)).isEqualTo(1);
        http.perform(get("/internal/v1/vote-audits").header("X-Internal-Key",KEY)).andExpect(status().isOk()).andExpect(jsonPath("$[0].sources[0].name").value("博主甲"));
        http.perform(get("/internal/v1/vote-audits/"+ID).header("X-Internal-Key",KEY).param("authorId","aaaaaaaaaaaaaaaaaaaaaaaa").param("field","directLimit"))
          .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.entries[0].rawValue").value("100元/日")).andExpect(jsonPath("$.entries[0].supportCount").value(1));
        http.perform(get("/internal/v1/vote-audits/"+ID).header("X-Internal-Key",KEY).param("field","feeRate")).andExpect(jsonPath("$.total").value(0));
        http.perform(post("/internal/v1/vote-audits").header("X-Internal-Key",KEY).contentType(MediaType.APPLICATION_JSON).content(payload().replace("100元/日","200元/日"))).andExpect(status().isConflict());
    }
    @Test void authenticatesAllRoutesAndRejectsInvalidDataAtomically() throws Exception {
        http.perform(get("/internal/v1/vote-audits")).andExpect(status().isUnauthorized());
        http.perform(get("/internal/v1/vote-audits/"+ID)).andExpect(status().isUnauthorized());
        http.perform(post("/internal/v1/vote-audits").contentType(MediaType.APPLICATION_JSON).content(payload())).andExpect(status().isUnauthorized());
        http.perform(post("/internal/v1/vote-audits").header("X-Internal-Key",KEY).contentType(MediaType.APPLICATION_JSON).content(payload().replace("https://www.xiaohongshu.com/explore/","https://evil.test/"))).andExpect(status().isBadRequest());
        http.perform(get("/internal/v1/vote-audits/"+ID).header("X-Internal-Key",KEY).param("page","-1")).andExpect(status().isBadRequest());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM vote_audit_batch",Long.class)).isZero();
    }
    @Test void listsFundsAndRestrictsEntriesToTheSelectedFund() throws Exception {
        var batch=(ObjectNode)json.readTree(payload());
        var second=(ObjectNode)batch.withArray("entries").get(0).deepCopy();
        second.put("fundCode","019442").put("fundName","Fund C").put("rawValue","200");
        batch.withArray("entries").add(second);
        http.perform(post("/internal/v1/vote-audits").header("X-Internal-Key",KEY).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsBytes(batch))).andExpect(status().isNoContent());
        http.perform(get("/internal/v1/vote-audits/"+ID+"/funds")).andExpect(status().isUnauthorized());
        http.perform(get("/internal/v1/vote-audits/"+ID+"/funds").header("X-Internal-Key",KEY)).andExpect(status().isOk())
          .andExpect(jsonPath("$.length()").value(2)).andExpect(jsonPath("$[0].fundCode").value("019441")).andExpect(jsonPath("$[1].fundCode").value("019442"));
        http.perform(get("/internal/v1/vote-audits/"+ID).header("X-Internal-Key",KEY).param("fundCode","019442"))
          .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.entries[0].rawValue").value("200"));
        http.perform(get("/internal/v1/vote-audits/"+ID).header("X-Internal-Key",KEY).param("fundCode","019442 OR 1=1")).andExpect(status().isBadRequest());
    }

}
