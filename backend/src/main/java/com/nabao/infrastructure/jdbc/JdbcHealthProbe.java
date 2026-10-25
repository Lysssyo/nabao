package com.nabao.infrastructure.jdbc;
import com.nabao.application.port.HealthProbe;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
@Component
public class JdbcHealthProbe implements HealthProbe {
    private final JdbcTemplate jdbc;
    public JdbcHealthProbe(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public void checkDatabase() { jdbc.queryForObject("SELECT 1", Integer.class); }
}
