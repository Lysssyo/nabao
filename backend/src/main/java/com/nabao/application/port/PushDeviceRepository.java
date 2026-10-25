package com.nabao.application.port;
import com.nabao.domain.PushModels.Device;
import java.time.Instant;
import java.util.List;
public interface PushDeviceRepository {
    Device find(String id, boolean lock);
    boolean insert(String id, String secretHash, String token, String environment, String baseline, Instant now);
    boolean refresh(String id, String token, String environment, Instant now);
    void reconfirm(String id, Instant now);
    void delete(String id);
    List<Device> eligible(String environment);
    boolean hasCursor();
    void establishBaseline(Device device, String digest);
    void clearPending(Device device);
    void pend(Device device, String digest, Instant now);
    void accept(Device device, String digest);
    void invalidate(Device device, String digest, String reason);
    void retry(Device device, String digest, int count, Instant next, String reason);
}
