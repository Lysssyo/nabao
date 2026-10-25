package com.nabao.application.port;
import com.nabao.domain.TableStatusModels.Summary;
import java.time.Instant;
public interface CollectorStatusRepository { Summary read(Instant now); }
