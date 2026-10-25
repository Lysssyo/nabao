package com.nabao.application.port;
import java.util.List;
import static com.nabao.domain.QuotaModels.*;
public interface RunRepository {
    String find(String id);
    boolean insert(RunReport report, String encoded);
    List<RunSummary> list();
}
