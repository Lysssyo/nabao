package com.nabao.web;
import com.nabao.application.VoteAuditService;
import com.nabao.application.ApplicationFailure;
import com.nabao.domain.VoteAuditModels.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.core.JsonParser;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Validator;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.List;
@RestController
@RequestMapping("/internal/v1/vote-audits")
public class VoteAuditController {
    private final VoteAuditService service;
    private final InternalKeyAuthorization authorization;
    private final ObjectMapper json;
    private final Validator validator;
    public VoteAuditController(VoteAuditService service, InternalKeyAuthorization authorization,ObjectMapper json,Validator validator){
        this.service=service;this.authorization=authorization;this.json=json;this.validator=validator;
    }
    @PostMapping public ResponseEntity<Void> record(@RequestHeader(value="X-Internal-Key",required=false) String key,HttpServletRequest request) throws java.io.IOException {
        authorize(key);
        byte[] body=request.getInputStream().readNBytes(16*1024*1024+1);
        if(body.length>16*1024*1024)throw new ApplicationFailure(ApplicationFailure.Kind.TOO_LARGE,"投票日志过大。");
        Batch batch;
        try { batch=json.readerFor(Batch.class).with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readValue(body); }
        catch(Exception e){throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT,"投票日志格式无效。");}
        if(batch==null || !validator.validate(batch).isEmpty())throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT,"投票日志字段无效。");
        service.record(batch);return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }
    @GetMapping public ResponseEntity<List<Summary>> list(@RequestHeader(value="X-Internal-Key",required=false) String key){
        authorize(key);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.list());
    }
    @GetMapping("/{id}/funds") public ResponseEntity<List<Fund>> funds(@RequestHeader(value="X-Internal-Key",required=false)String key,@PathVariable String id){
        authorize(key);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.funds(id));
    }
    @GetMapping("/{id}") public ResponseEntity<Page> entries(@RequestHeader(value="X-Internal-Key",required=false)String key,@PathVariable String id,
            @RequestParam(required=false)String authorId,@RequestParam(required=false)String field,@RequestParam(required=false)String fundCode,@RequestParam(defaultValue="0")int page){
        authorize(key);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.entries(id,authorId,field,fundCode,page));
    }
    private void authorize(String key){authorization.require(key,"投票日志服务尚未配置管理密钥。");}
}
