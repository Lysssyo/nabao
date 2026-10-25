package com.nabao.application.port;
import com.nabao.domain.PushStateModels.State;
import java.io.IOException;
public interface PushStateRepository {
    State read() throws IOException;
    void save(State state) throws IOException;
}
