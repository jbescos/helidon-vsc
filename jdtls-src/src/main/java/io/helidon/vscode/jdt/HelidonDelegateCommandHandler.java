package io.helidon.vscode.jdt;

import java.util.Collections;
import java.util.List;
import java.util.Map;

import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;

public final class HelidonDelegateCommandHandler implements IDelegateCommandHandler {
    public static final String COMMAND_ID = "io.helidon.vscode.resolveEndpoints";

    private static final int SUPPORTED_REQUEST_VERSION = 1;
    private static final Map<String, Object> UNSUPPORTED_RESPONSE = Collections.singletonMap("supported", Boolean.FALSE);

    private final HelidonEndpointResolver resolver = new HelidonEndpointResolver();

    @Override
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) {
        if (!COMMAND_ID.equals(commandId)) {
            return UNSUPPORTED_RESPONSE;
        }

        if (arguments == null || arguments.isEmpty() || !(arguments.get(0) instanceof String requestJson)) {
            return UNSUPPORTED_RESPONSE;
        }

        try {
            return resolver.resolve(requestJson, SUPPORTED_REQUEST_VERSION, monitor);
        } catch (Exception ignored) {
            return UNSUPPORTED_RESPONSE;
        }
    }
}
