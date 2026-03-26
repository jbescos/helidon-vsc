package io.helidon.vscode.jdt;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import org.eclipse.core.resources.IResource;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.IPackageFragment;
import org.eclipse.jdt.core.IPackageFragmentRoot;
import org.eclipse.jdt.core.JavaModelException;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.Annotation;
import org.eclipse.jdt.core.dom.Block;
import org.eclipse.jdt.core.dom.CastExpression;
import org.eclipse.jdt.core.dom.ClassInstanceCreation;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.CreationReference;
import org.eclipse.jdt.core.dom.Expression;
import org.eclipse.jdt.core.dom.ExpressionMethodReference;
import org.eclipse.jdt.core.dom.FieldAccess;
import org.eclipse.jdt.core.dom.IBinding;
import org.eclipse.jdt.core.dom.IMethodBinding;
import org.eclipse.jdt.core.dom.ITypeBinding;
import org.eclipse.jdt.core.dom.IVariableBinding;
import org.eclipse.jdt.core.dom.InfixExpression;
import org.eclipse.jdt.core.dom.Initializer;
import org.eclipse.jdt.core.dom.LambdaExpression;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.MethodInvocation;
import org.eclipse.jdt.core.dom.NormalAnnotation;
import org.eclipse.jdt.core.dom.ParenthesizedExpression;
import org.eclipse.jdt.core.dom.QualifiedName;
import org.eclipse.jdt.core.dom.ReturnStatement;
import org.eclipse.jdt.core.dom.SingleMemberAnnotation;
import org.eclipse.jdt.core.dom.SimpleName;
import org.eclipse.jdt.core.dom.SingleVariableDeclaration;
import org.eclipse.jdt.core.dom.Statement;
import org.eclipse.jdt.core.dom.StringLiteral;
import org.eclipse.jdt.core.dom.SuperFieldAccess;
import org.eclipse.jdt.core.dom.SuperMethodReference;
import org.eclipse.jdt.core.dom.TextBlock;
import org.eclipse.jdt.core.dom.ThisExpression;
import org.eclipse.jdt.core.dom.TypeDeclaration;
import org.eclipse.jdt.core.dom.TypeMethodReference;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;
import org.eclipse.jdt.ls.core.internal.ProjectUtils;
import org.eclipse.jdt.ls.core.internal.ResourceUtils;

import com.google.gson.Gson;
import com.google.gson.JsonParseException;

final class HelidonEndpointResolver {
    private static final Map<String, Object> UNSUPPORTED_RESPONSE = Collections.singletonMap("supported", Boolean.FALSE);

    private static final Set<String> ROUTING_RECEIVER_TYPES = Set.of(
            "io.helidon.webserver.Routing.Builder",
            "io.helidon.webserver.Routing.Rules",
            "io.helidon.webserver.http.HttpRouting.Builder",
            "io.helidon.webserver.http.HttpRules");

    private static final Set<String> HELIDON_SERVICE_TYPES = Set.of(
            "io.helidon.webserver.Service",
            "io.helidon.webserver.http.HttpService");

    private static final Set<String> JAX_RS_PATH_ANNOTATIONS = Set.of(
            "Path",
            "jakarta.ws.rs.Path",
            "javax.ws.rs.Path");

    private static final Map<String, String> JAX_RS_HTTP_ANNOTATIONS = Map.ofEntries(
            Map.entry("GET", "GET"),
            Map.entry("POST", "POST"),
            Map.entry("PUT", "PUT"),
            Map.entry("DELETE", "DELETE"),
            Map.entry("PATCH", "PATCH"),
            Map.entry("HEAD", "HEAD"),
            Map.entry("OPTIONS", "OPTIONS"),
            Map.entry("jakarta.ws.rs.GET", "GET"),
            Map.entry("jakarta.ws.rs.POST", "POST"),
            Map.entry("jakarta.ws.rs.PUT", "PUT"),
            Map.entry("jakarta.ws.rs.DELETE", "DELETE"),
            Map.entry("jakarta.ws.rs.PATCH", "PATCH"),
            Map.entry("jakarta.ws.rs.HEAD", "HEAD"),
            Map.entry("jakarta.ws.rs.OPTIONS", "OPTIONS"),
            Map.entry("javax.ws.rs.GET", "GET"),
            Map.entry("javax.ws.rs.POST", "POST"),
            Map.entry("javax.ws.rs.PUT", "PUT"),
            Map.entry("javax.ws.rs.DELETE", "DELETE"),
            Map.entry("javax.ws.rs.PATCH", "PATCH"),
            Map.entry("javax.ws.rs.HEAD", "HEAD"),
            Map.entry("javax.ws.rs.OPTIONS", "OPTIONS"));

    private static final Map<String, String> ROUTE_METHOD_NAMES = Map.ofEntries(
            Map.entry("get", "GET"),
            Map.entry("post", "POST"),
            Map.entry("put", "PUT"),
            Map.entry("delete", "DELETE"),
            Map.entry("patch", "PATCH"),
            Map.entry("head", "HEAD"),
            Map.entry("options", "OPTIONS"),
            Map.entry("trace", "TRACE"));

    private static final Set<String> HELIDON_HTTP_METHOD_TYPES = Set.of(
            "io.helidon.common.http.Http.Method",
            "io.helidon.http.Method");

    private final Gson gson = new Gson();

    Object resolve(String requestJson, int supportedRequestVersion, IProgressMonitor monitor) throws JavaModelException {
        EndpointRequest request;
        try {
            request = gson.fromJson(requestJson, EndpointRequest.class);
        } catch (JsonParseException ignored) {
            return UNSUPPORTED_RESPONSE;
        }

        if (request == null || request.version != supportedRequestVersion || request.workspaceFolderUris == null) {
            return UNSUPPORTED_RESPONSE;
        }

        List<WorkspaceFolderContext> folders = resolveWorkspaceFolders(request.workspaceFolderUris);
        if (folders.isEmpty()) {
            return UNSUPPORTED_RESPONSE;
        }

        Map<String, TypeRouteInfo> types = new LinkedHashMap<>();
        for (UnitContext unitContext : collectCompilationUnits(folders, monitor)) {
            checkCanceled(monitor);
            analyzeCompilationUnit(unitContext, folders, types, monitor);
        }

        return buildResponse(types);
    }

    private List<WorkspaceFolderContext> resolveWorkspaceFolders(List<String> workspaceFolderUris) {
        List<WorkspaceFolderContext> folders = new ArrayList<>();
        Set<String> seenPaths = new HashSet<>();

        for (String workspaceFolderUri : workspaceFolderUris) {
            if (workspaceFolderUri == null || workspaceFolderUri.isBlank()) {
                continue;
            }

            IPath path = ResourceUtils.canonicalFilePathFromURI(workspaceFolderUri);
            if (path == null) {
                path = ResourceUtils.filePathFromURI(workspaceFolderUri);
            }
            if (path == null) {
                continue;
            }

            String portablePath = path.toPortableString();
            if (seenPaths.add(portablePath)) {
                folders.add(new WorkspaceFolderContext(path));
            }
        }

        return folders;
    }

    private List<UnitContext> collectCompilationUnits(List<WorkspaceFolderContext> folders, IProgressMonitor monitor)
            throws JavaModelException {
        Map<String, UnitContext> unitsByUri = new LinkedHashMap<>();

        for (IJavaProject javaProject : ProjectUtils.getJavaProjects()) {
            checkCanceled(monitor);
            for (IPackageFragmentRoot root : javaProject.getPackageFragmentRoots()) {
                checkCanceled(monitor);
                if (root.getKind() != IPackageFragmentRoot.K_SOURCE) {
                    continue;
                }

                for (Object child : root.getChildren()) {
                    if (!(child instanceof IPackageFragment fragment)) {
                        continue;
                    }

                    for (org.eclipse.jdt.core.ICompilationUnit compilationUnit : fragment.getCompilationUnits()) {
                        UnitContext unitContext = createUnitContext(compilationUnit, folders);
                        if (unitContext != null) {
                            unitsByUri.putIfAbsent(unitContext.uri, unitContext);
                        }
                    }
                }
            }
        }

        return new ArrayList<>(unitsByUri.values());
    }

    private UnitContext createUnitContext(
            org.eclipse.jdt.core.ICompilationUnit compilationUnit,
            List<WorkspaceFolderContext> folders) {
        IResource resource = compilationUnit.getResource();
        if (resource == null || resource.getLocation() == null || resource.getLocationURI() == null) {
            return null;
        }

        WorkspaceFolderContext folder = selectWorkspaceFolder(resource.getLocation(), folders);
        if (folder == null) {
            return null;
        }

        String relativePath = resource.getLocation().makeRelativeTo(folder.path).toPortableString();
        return new UnitContext(compilationUnit, resource.getLocationURI().toString(), relativePath);
    }

    private WorkspaceFolderContext selectWorkspaceFolder(IPath filePath, List<WorkspaceFolderContext> folders) {
        WorkspaceFolderContext bestMatch = null;
        int longestMatch = -1;

        for (WorkspaceFolderContext folder : folders) {
            if (!folder.path.isPrefixOf(filePath)) {
                continue;
            }

            int segmentCount = folder.path.segmentCount();
            if (segmentCount > longestMatch) {
                longestMatch = segmentCount;
                bestMatch = folder;
            }
        }

        return bestMatch;
    }

    private void analyzeCompilationUnit(
            UnitContext unitContext,
            List<WorkspaceFolderContext> folders,
            Map<String, TypeRouteInfo> types,
            IProgressMonitor monitor) {
        CompilationUnit root = parseCompilationUnit(unitContext.compilationUnit, monitor);
        root.accept(new RouteVisitor(root, unitContext, folders, types));
    }

    private CompilationUnit parseCompilationUnit(org.eclipse.jdt.core.ICompilationUnit compilationUnit, IProgressMonitor monitor) {
        ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
        parser.setKind(ASTParser.K_COMPILATION_UNIT);
        parser.setSource(compilationUnit);
        parser.setProject(compilationUnit.getJavaProject());
        parser.setResolveBindings(true);
        parser.setBindingsRecovery(true);
        parser.setStatementsRecovery(true);
        return (CompilationUnit) parser.createAST(monitor);
    }

    private Map<String, Object> buildResponse(Map<String, TypeRouteInfo> types) {
        Map<String, Integer> incomingRegistrations = new LinkedHashMap<>();
        for (TypeRouteInfo info : types.values()) {
            for (ServiceRegistration registration : info.registrations) {
                incomingRegistrations.merge(registration.targetTypeKey, 1, Integer::sum);
            }
        }

        List<EndpointDescriptor> discoveredEndpoints = new ArrayList<>();
        Set<String> seenEndpoints = new HashSet<>();
        Set<String> rootTypeKeys = new LinkedHashSet<>();

        for (TypeRouteInfo info : types.values()) {
            if (info.directEndpoints.isEmpty() && info.registrations.isEmpty()) {
                continue;
            }

            if (!info.serviceType || !incomingRegistrations.containsKey(info.key)) {
                rootTypeKeys.add(info.key);
            }
        }

        for (String rootTypeKey : rootTypeKeys) {
            expandType(rootTypeKey, "", types, discoveredEndpoints, seenEndpoints, new ArrayDeque<>());
        }

        Map<String, GroupAccumulator> groupsByKey = new LinkedHashMap<>();
        for (EndpointDescriptor endpoint : discoveredEndpoints) {
            if (endpoint.uri == null || endpoint.relativePath == null) {
                continue;
            }

            String groupKey = endpoint.relativePath + "#" + endpoint.className;
            GroupAccumulator group = groupsByKey.get(groupKey);
            if (group == null) {
                group = new GroupAccumulator(endpoint.className, endpoint.relativePath, endpoint.uri, endpoint.line);
                groupsByKey.put(groupKey, group);
            } else {
                group.line = Math.min(group.line, endpoint.line);
            }
            group.endpoints.add(endpoint);
        }

        List<GroupAccumulator> groups = new ArrayList<>(groupsByKey.values());
        groups.sort((left, right) -> {
            int classComparison = left.className.compareTo(right.className);
            if (classComparison != 0) {
                return classComparison;
            }
            return left.relativePath.compareTo(right.relativePath);
        });

        List<Map<String, Object>> groupPayloads = new ArrayList<>();
        for (GroupAccumulator group : groups) {
            group.endpoints.sort((left, right) -> {
                int pathComparison = left.path.compareTo(right.path);
                if (pathComparison != 0) {
                    return pathComparison;
                }
                return left.httpMethod.compareTo(right.httpMethod);
            });

            List<Map<String, Object>> endpointPayloads = new ArrayList<>();
            for (EndpointDescriptor endpoint : group.endpoints) {
                endpointPayloads.add(endpoint.toMap());
            }

            Map<String, Object> groupPayload = new LinkedHashMap<>();
            groupPayload.put("className", group.className);
            groupPayload.put("relativePath", group.relativePath);
            groupPayload.put("uri", group.uri);
            groupPayload.put("line", group.line);
            groupPayload.put("endpoints", endpointPayloads);
            groupPayloads.add(groupPayload);
        }

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("supported", Boolean.TRUE);
        response.put("groups", groupPayloads);
        return response;
    }

    private void expandType(
            String typeKey,
            String prefixPath,
            Map<String, TypeRouteInfo> types,
            List<EndpointDescriptor> discoveredEndpoints,
            Set<String> seenEndpoints,
            Deque<String> traversalStack) {
        TypeRouteInfo info = types.get(typeKey);
        if (info == null || traversalStack.contains(typeKey)) {
            return;
        }

        traversalStack.addLast(typeKey);
        for (EndpointDescriptor directEndpoint : info.directEndpoints) {
            EndpointDescriptor resolvedEndpoint = directEndpoint.withPath(joinEndpointPath(prefixPath, directEndpoint.path));
            if (seenEndpoints.add(resolvedEndpoint.identityKey())) {
                discoveredEndpoints.add(resolvedEndpoint);
            }
        }

        for (ServiceRegistration registration : info.registrations) {
            expandType(
                    registration.targetTypeKey,
                    joinEndpointPath(prefixPath, registration.pathPrefix),
                    types,
                    discoveredEndpoints,
                    seenEndpoints,
                    traversalStack);
        }
        traversalStack.removeLast();
    }

    private static boolean isRoutingReceiverType(ITypeBinding typeBinding) {
        return isTypeOrSubtypeOf(typeBinding, ROUTING_RECEIVER_TYPES);
    }

    private static boolean isServiceType(ITypeBinding typeBinding) {
        return isTypeOrSubtypeOf(typeBinding, HELIDON_SERVICE_TYPES);
    }

    private static boolean isTypeOrSubtypeOf(ITypeBinding typeBinding, Set<String> qualifiedTypeNames) {
        if (typeBinding == null) {
            return false;
        }

        ITypeBinding normalized = normalizeTypeBinding(typeBinding);
        if (normalized == null) {
            return false;
        }

        Set<String> visitedKeys = new HashSet<>();
        Deque<ITypeBinding> queue = new ArrayDeque<>();
        queue.add(normalized);

        while (!queue.isEmpty()) {
            ITypeBinding candidate = normalizeTypeBinding(queue.removeFirst());
            if (candidate == null) {
                continue;
            }

            String candidateKey = candidate.getKey();
            if (candidateKey != null && !visitedKeys.add(candidateKey)) {
                continue;
            }

            String qualifiedName = candidate.getQualifiedName();
            if (qualifiedTypeNames.contains(qualifiedName)) {
                return true;
            }

            ITypeBinding superclass = candidate.getSuperclass();
            if (superclass != null) {
                queue.addLast(superclass);
            }
            for (ITypeBinding implementedInterface : candidate.getInterfaces()) {
                queue.addLast(implementedInterface);
            }
        }

        return false;
    }

    private static ITypeBinding normalizeTypeBinding(ITypeBinding typeBinding) {
        if (typeBinding == null) {
            return null;
        }

        ITypeBinding declaration = typeBinding.getTypeDeclaration();
        if (declaration != null) {
            return declaration;
        }

        ITypeBinding erasure = typeBinding.getErasure();
        return erasure != null ? erasure : typeBinding;
    }

    private static String normalizeEndpointPathSegment(String path) {
        if (path == null) {
            return "";
        }

        String trimmed = path.trim();
        if (trimmed.isEmpty() || "/".equals(trimmed)) {
            return "";
        }

        int start = 0;
        int end = trimmed.length();
        while (start < end && trimmed.charAt(start) == '/') {
            start += 1;
        }
        while (end > start && trimmed.charAt(end - 1) == '/') {
            end -= 1;
        }

        return trimmed.substring(start, end);
    }

    private static String joinEndpointPath(String basePath, String methodPath) {
        String normalizedBase = normalizeEndpointPathSegment(basePath);
        String normalizedMethod = normalizeEndpointPathSegment(methodPath);

        if (normalizedBase.isEmpty() && normalizedMethod.isEmpty()) {
            return "/";
        }
        if (normalizedBase.isEmpty()) {
            return "/" + normalizedMethod;
        }
        if (normalizedMethod.isEmpty()) {
            return "/" + normalizedBase;
        }
        return "/" + normalizedBase + "/" + normalizedMethod;
    }

    private static String typeDisplayName(ITypeBinding typeBinding) {
        List<String> names = new ArrayList<>();
        for (ITypeBinding current = normalizeTypeBinding(typeBinding); current != null; current = current.getDeclaringClass()) {
            String name = current.getName();
            if (name == null || name.isBlank()) {
                continue;
            }
            names.add(name);
        }

        if (names.isEmpty()) {
            return "Anonymous";
        }

        Collections.reverse(names);
        return String.join(".", names);
    }

    private static int zeroBasedLine(CompilationUnit root, int offset) {
        int line = root.getLineNumber(offset);
        return line <= 0 ? 0 : line - 1;
    }

    private static int zeroBasedLine(String source, int offset) {
        if (source == null || source.isEmpty()) {
            return 0;
        }

        int clampedOffset = Math.max(0, Math.min(offset, source.length()));
        int line = 0;
        for (int index = 0; index < clampedOffset; index += 1) {
            if (source.charAt(index) == '\n') {
                line += 1;
            }
        }
        return line;
    }

    private static void checkCanceled(IProgressMonitor monitor) {
        if (monitor != null && monitor.isCanceled()) {
            throw new OperationCanceledException();
        }
    }

    private static final class EndpointRequest {
        int version;
        List<String> workspaceFolderUris;
    }

    private static final class WorkspaceFolderContext {
        private final IPath path;

        private WorkspaceFolderContext(IPath path) {
            this.path = path;
        }
    }

    private static final class UnitContext {
        private final org.eclipse.jdt.core.ICompilationUnit compilationUnit;
        private final String uri;
        private final String relativePath;

        private UnitContext(org.eclipse.jdt.core.ICompilationUnit compilationUnit, String uri, String relativePath) {
            this.compilationUnit = compilationUnit;
            this.uri = uri;
            this.relativePath = relativePath;
        }
    }

    private static final class TypeRouteInfo {
        private final String key;
        private String className;
        private String uri;
        private String relativePath;
        private boolean serviceType;
        private final List<EndpointDescriptor> directEndpoints = new ArrayList<>();
        private final List<ServiceRegistration> registrations = new ArrayList<>();

        private TypeRouteInfo(String key, String className) {
            this.key = key;
            this.className = className;
        }
    }

    private static final class EndpointDescriptor {
        private final String className;
        private final String methodName;
        private final String httpMethod;
        private final String path;
        private final String relativePath;
        private final String uri;
        private final int line;

        private EndpointDescriptor(
                String className,
                String methodName,
                String httpMethod,
                String path,
                String relativePath,
                String uri,
                int line) {
            this.className = className;
            this.methodName = methodName;
            this.httpMethod = httpMethod;
            this.path = path;
            this.relativePath = relativePath;
            this.uri = uri;
            this.line = Math.max(0, line);
        }

        private EndpointDescriptor withPath(String resolvedPath) {
            return new EndpointDescriptor(className, methodName, httpMethod, resolvedPath, relativePath, uri, line);
        }

        private String identityKey() {
            return uri + "#" + className + "#" + methodName + "#" + httpMethod + "#" + path + "#" + line;
        }

        private Map<String, Object> toMap() {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("className", className);
            payload.put("methodName", methodName);
            payload.put("httpMethod", httpMethod);
            payload.put("path", path);
            payload.put("relativePath", relativePath);
            payload.put("uri", uri);
            payload.put("line", line);
            return payload;
        }
    }

    private static final class ServiceRegistration {
        private final String targetTypeKey;
        private final String pathPrefix;

        private ServiceRegistration(String targetTypeKey, String pathPrefix) {
            this.targetTypeKey = targetTypeKey;
            this.pathPrefix = pathPrefix;
        }
    }

    private static final class GroupAccumulator {
        private final String className;
        private final String relativePath;
        private final String uri;
        private int line;
        private final List<EndpointDescriptor> endpoints = new ArrayList<>();

        private GroupAccumulator(String className, String relativePath, String uri, int line) {
            this.className = className;
            this.relativePath = relativePath;
            this.uri = uri;
            this.line = line;
        }
    }

    private static final class CallableContext {
        private final String name;
        private final int line;

        private CallableContext(String name, int line) {
            this.name = name;
            this.line = line;
        }
    }

    private static final class OwnerContext {
        private final TypeRouteInfo info;
        private final ITypeBinding binding;
        private final String jaxRsPath;

        private OwnerContext(TypeRouteInfo info, ITypeBinding binding, String jaxRsPath) {
            this.info = info;
            this.binding = binding;
            this.jaxRsPath = jaxRsPath;
        }
    }

    private static final class ResolvedHandlerTarget {
        private final String declaringTypeKey;
        private final String methodName;
        private final int line;

        private ResolvedHandlerTarget(String declaringTypeKey, String methodName, int line) {
            this.declaringTypeKey = declaringTypeKey;
            this.methodName = methodName;
            this.line = line;
        }
    }

    private final class RouteVisitor extends ASTVisitor {
        private final CompilationUnit root;
        private final UnitContext unitContext;
        private final List<WorkspaceFolderContext> folders;
        private final Map<String, TypeRouteInfo> types;
        private final Deque<OwnerContext> owners = new ArrayDeque<>();
        private final Deque<CallableContext> callables = new ArrayDeque<>();

        private RouteVisitor(
                CompilationUnit root,
                UnitContext unitContext,
                List<WorkspaceFolderContext> folders,
                Map<String, TypeRouteInfo> types) {
            this.root = root;
            this.unitContext = unitContext;
            this.folders = folders;
            this.types = types;
        }

        @Override
        public boolean visit(TypeDeclaration node) {
            ITypeBinding binding = normalizeTypeBinding(node.resolveBinding());
            if (binding == null || binding.getKey() == null) {
                return true;
            }

            TypeRouteInfo info = typeInfoForBinding(binding, unitContext);
            owners.addLast(new OwnerContext(info, binding, readPathAnnotation(node.modifiers())));
            return true;
        }

        @Override
        public void endVisit(TypeDeclaration node) {
            ITypeBinding binding = normalizeTypeBinding(node.resolveBinding());
            if (binding != null && binding.getKey() != null && !owners.isEmpty()) {
                owners.removeLast();
            }
        }

        @Override
        public boolean visit(MethodDeclaration node) {
            if (owners.isEmpty()) {
                return true;
            }

            String methodName = node.getName() != null ? node.getName().getIdentifier() : "<method>";
            callables.addLast(new CallableContext(methodName, zeroBasedLine(root, node.getStartPosition())));
            collectJaxRsEndpoint(node, owners.peekLast());
            return true;
        }

        @Override
        public void endVisit(MethodDeclaration node) {
            if (!callables.isEmpty()) {
                callables.removeLast();
            }
        }

        @Override
        public boolean visit(Initializer node) {
            if (!owners.isEmpty()) {
                callables.addLast(new CallableContext("<initializer>", zeroBasedLine(root, node.getStartPosition())));
            }
            return true;
        }

        @Override
        public void endVisit(Initializer node) {
            if (!owners.isEmpty() && !callables.isEmpty()) {
                callables.removeLast();
            }
        }

        @Override
        public boolean visit(MethodInvocation node) {
            if (owners.isEmpty()) {
                return true;
            }

            ITypeBinding receiverType = resolveReceiverType(node);
            if (!isRoutingReceiverType(receiverType)) {
                return true;
            }

            String methodName = node.getName().getIdentifier();
            String shorthandHttpMethod = ROUTE_METHOD_NAMES.get(methodName.toLowerCase(Locale.ROOT));
            if (shorthandHttpMethod != null) {
                collectShorthandRoute(node, shorthandHttpMethod);
                return true;
            }

            if ("route".equals(methodName)) {
                collectGenericRoute(node);
                return true;
            }

            if ("register".equals(methodName)) {
                collectRegistration(node);
                return true;
            }

            return true;
        }

        private void collectJaxRsEndpoint(MethodDeclaration node, OwnerContext owner) {
            String httpMethod = resolveJaxRsHttpMethod(node.modifiers());
            if (httpMethod == null) {
                return;
            }

            String methodPath = readPathAnnotation(node.modifiers());
            owner.info.directEndpoints.add(new EndpointDescriptor(
                    owner.info.className,
                    node.getName().getIdentifier(),
                    httpMethod,
                    joinEndpointPath(owner.jaxRsPath, methodPath),
                    owner.info.relativePath,
                    owner.info.uri,
                    zeroBasedLine(root, node.getName().getStartPosition())));
        }

        private void collectShorthandRoute(MethodInvocation node, String httpMethod) {
            List<Expression> arguments = expressionArguments(node);
            if (arguments.isEmpty()) {
                return;
            }

            String path = "";
            int handlerStart = 0;
            if (isStringExpression(arguments.get(0))) {
                String resolvedPath = evaluateStringExpression(arguments.get(0));
                if (resolvedPath == null) {
                    return;
                }
                path = resolvedPath;
                handlerStart = 1;
            }

            if (handlerStart >= arguments.size()) {
                return;
            }

            for (int index = handlerStart; index < arguments.size(); index += 1) {
                addRouteEndpoint(node, httpMethod, path, arguments.get(index));
            }
        }

        private void collectGenericRoute(MethodInvocation node) {
            List<Expression> arguments = expressionArguments(node);
            if (arguments.size() < 2) {
                return;
            }

            String httpMethod = resolveHelidonHttpMethod(arguments.get(0));
            if (httpMethod == null) {
                return;
            }

            if (arguments.size() == 2) {
                if (isStringExpression(arguments.get(1))) {
                    return;
                }
                addRouteEndpoint(node, httpMethod, "", arguments.get(1));
                return;
            }

            if (!isStringExpression(arguments.get(1))) {
                return;
            }

            String path = evaluateStringExpression(arguments.get(1));
            if (path == null) {
                return;
            }

            addRouteEndpoint(node, httpMethod, path, arguments.get(arguments.size() - 1));
        }

        private void collectRegistration(MethodInvocation node) {
            List<Expression> arguments = expressionArguments(node);
            if (arguments.isEmpty()) {
                return;
            }

            String pathPrefix = "";
            int serviceStart = 0;
            if (isStringExpression(arguments.get(0))) {
                String resolvedPath = evaluateStringExpression(arguments.get(0));
                if (resolvedPath == null) {
                    return;
                }
                pathPrefix = resolvedPath;
                serviceStart = 1;
            }

            if (serviceStart >= arguments.size()) {
                return;
            }

            OwnerContext owner = owners.peekLast();
            if (owner == null) {
                return;
            }

            for (int index = serviceStart; index < arguments.size(); index += 1) {
                ITypeBinding serviceType = resolveRegisteredServiceType(arguments.get(index));
                if (serviceType == null || serviceType.getKey() == null) {
                    continue;
                }

                TypeRouteInfo targetInfo = typeInfoForBinding(serviceType, null);
                targetInfo.serviceType = true;
                owner.info.registrations.add(new ServiceRegistration(targetInfo.key, pathPrefix));
            }
        }

        private void addRouteEndpoint(MethodInvocation node, String httpMethod, String localPath, Expression handlerExpression) {
            OwnerContext owner = owners.peekLast();
            if (owner == null) {
                return;
            }

            CallableContext callable = callables.peekLast();
            ResolvedHandlerTarget handlerTarget = resolveHandlerTarget(handlerExpression);
            int fallbackLine = callable != null ? callable.line : zeroBasedLine(root, node.getStartPosition());
            if (handlerExpression instanceof LambdaExpression) {
                fallbackLine = zeroBasedLine(root, handlerExpression.getStartPosition());
            }

            int line = fallbackLine;
            if (handlerTarget != null && owner.info.key.equals(handlerTarget.declaringTypeKey)) {
                line = handlerTarget.line;
            }

            String methodName = fallbackHandlerName(callable);
            if (handlerTarget != null && handlerTarget.methodName != null && !handlerTarget.methodName.isBlank()) {
                methodName = handlerTarget.methodName;
            }

            owner.info.directEndpoints.add(new EndpointDescriptor(
                    owner.info.className,
                    methodName,
                    httpMethod,
                    joinEndpointPath("", localPath),
                    owner.info.relativePath,
                    owner.info.uri,
                    line));
        }

        private String fallbackHandlerName(CallableContext callable) {
            if (callable != null && callable.name != null && !callable.name.isBlank()) {
                return callable.name;
            }
            return "<handler>";
        }

        private ITypeBinding resolveReceiverType(MethodInvocation node) {
            Expression expression = node.getExpression();
            if (expression != null) {
                return normalizeTypeBinding(expression.resolveTypeBinding());
            }

            IMethodBinding methodBinding = node.resolveMethodBinding();
            return methodBinding == null ? null : normalizeTypeBinding(methodBinding.getDeclaringClass());
        }

        private ResolvedHandlerTarget resolveHandlerTarget(Expression expression) {
            if (expression == null) {
                return null;
            }

            if (expression instanceof ParenthesizedExpression parenthesizedExpression) {
                return resolveHandlerTarget(parenthesizedExpression.getExpression());
            }

            if (expression instanceof CastExpression castExpression) {
                return resolveHandlerTarget(castExpression.getExpression());
            }

            if (expression instanceof ExpressionMethodReference expressionMethodReference) {
                return handlerTargetFromMethodBinding(expressionMethodReference.resolveMethodBinding());
            }

            if (expression instanceof TypeMethodReference typeMethodReference) {
                return handlerTargetFromMethodBinding(typeMethodReference.resolveMethodBinding());
            }

            if (expression instanceof SuperMethodReference superMethodReference) {
                return handlerTargetFromMethodBinding(superMethodReference.resolveMethodBinding());
            }

            if (expression instanceof LambdaExpression lambdaExpression) {
                return handlerTargetFromLambda(lambdaExpression);
            }

            if (expression instanceof SimpleName simpleName) {
                return resolveHandlerTargetFromVariable(simpleName.resolveBinding());
            }

            if (expression instanceof QualifiedName qualifiedName) {
                return resolveHandlerTargetFromVariable(qualifiedName.resolveBinding());
            }

            if (expression instanceof FieldAccess fieldAccess) {
                return resolveHandlerTargetFromVariable(fieldAccess.resolveFieldBinding());
            }

            if (expression instanceof SuperFieldAccess superFieldAccess) {
                return resolveHandlerTargetFromVariable(superFieldAccess.resolveFieldBinding());
            }

            return null;
        }

        private ResolvedHandlerTarget resolveHandlerTargetFromVariable(IBinding binding) {
            if (!(binding instanceof IVariableBinding variableBinding)) {
                return null;
            }

            ASTNode declaringNode = root.findDeclaringNode(variableBinding.getVariableDeclaration());
            if (declaringNode instanceof VariableDeclarationFragment variableDeclaration) {
                return resolveHandlerTarget(variableDeclaration.getInitializer());
            }
            if (declaringNode instanceof SingleVariableDeclaration variableDeclaration) {
                return resolveHandlerTarget(variableDeclaration.getInitializer());
            }
            return null;
        }

        private ResolvedHandlerTarget handlerTargetFromLambda(LambdaExpression lambdaExpression) {
            ASTNode body = lambdaExpression.getBody();
            if (body instanceof Expression expressionBody) {
                return handlerTargetFromExpressionBody(expressionBody);
            }

            if (body instanceof Block block && block.statements().size() == 1) {
                Object onlyStatement = block.statements().get(0);
                if (onlyStatement instanceof org.eclipse.jdt.core.dom.ExpressionStatement expressionStatement) {
                    return handlerTargetFromExpressionBody(expressionStatement.getExpression());
                }
                if (onlyStatement instanceof ReturnStatement returnStatement) {
                    return handlerTargetFromExpressionBody(returnStatement.getExpression());
                }
            }

            return null;
        }

        private ResolvedHandlerTarget handlerTargetFromExpressionBody(Expression expression) {
            if (expression instanceof MethodInvocation methodInvocation) {
                return handlerTargetFromMethodBinding(methodInvocation.resolveMethodBinding());
            }
            return null;
        }

        private ResolvedHandlerTarget handlerTargetFromMethodBinding(IMethodBinding methodBinding) {
            if (methodBinding == null) {
                return null;
            }

            IMethodBinding declaration = methodBinding.getMethodDeclaration();
            if (declaration == null) {
                return null;
            }

            ITypeBinding declaringType = normalizeTypeBinding(declaration.getDeclaringClass());
            String declaringTypeKey = declaringType != null ? declaringType.getKey() : null;
            ASTNode declaringNode = root.findDeclaringNode(declaration);
            if (declaringNode instanceof MethodDeclaration methodDeclaration) {
                return new ResolvedHandlerTarget(
                        declaringTypeKey,
                        declaration.getName(),
                        zeroBasedLine(root, methodDeclaration.getName().getStartPosition()));
            }

            return new ResolvedHandlerTarget(
                    declaringTypeKey,
                    declaration.getName(),
                    callables.isEmpty() ? 0 : callables.peekLast().line);
        }

        private TypeRouteInfo typeInfoForBinding(ITypeBinding typeBinding, UnitContext sourceUnit) {
            ITypeBinding normalizedBinding = normalizeTypeBinding(typeBinding);
            String key = normalizedBinding.getKey();
            TypeRouteInfo info = types.get(key);
            if (info == null) {
                info = new TypeRouteInfo(key, typeDisplayName(normalizedBinding));
                types.put(key, info);
            }

            info.className = typeDisplayName(normalizedBinding);
            info.serviceType = info.serviceType || isServiceType(normalizedBinding);
            if (sourceUnit != null) {
                info.uri = sourceUnit.uri;
                info.relativePath = sourceUnit.relativePath;
            }

            return info;
        }

        private ITypeBinding resolveRegisteredServiceType(Expression expression) {
            if (expression == null) {
                return null;
            }

            if (expression instanceof ParenthesizedExpression parenthesizedExpression) {
                return resolveRegisteredServiceType(parenthesizedExpression.getExpression());
            }

            if (expression instanceof CastExpression castExpression) {
                return resolveRegisteredServiceType(castExpression.getExpression());
            }

            if (expression instanceof CreationReference creationReference) {
                return concreteServiceType(creationReference.getType().resolveBinding());
            }

            if (expression instanceof ClassInstanceCreation classInstanceCreation) {
                return concreteServiceType(classInstanceCreation.resolveTypeBinding());
            }

            if (expression instanceof SimpleName simpleName) {
                return resolveRegisteredServiceTypeFromVariable(simpleName.resolveBinding());
            }

            if (expression instanceof QualifiedName qualifiedName) {
                return resolveRegisteredServiceTypeFromVariable(qualifiedName.resolveBinding());
            }

            if (expression instanceof FieldAccess fieldAccess) {
                return resolveRegisteredServiceTypeFromVariable(fieldAccess.resolveFieldBinding());
            }

            if (expression instanceof ThisExpression) {
                return concreteServiceType(expression.resolveTypeBinding());
            }

            if (expression instanceof MethodInvocation methodInvocation) {
                IMethodBinding methodBinding = methodInvocation.resolveMethodBinding();
                if (methodBinding != null) {
                    ITypeBinding returnType = concreteServiceType(methodBinding.getReturnType());
                    if (returnType != null) {
                        return returnType;
                    }
                }
            }

            if (expression instanceof ExpressionMethodReference expressionMethodReference) {
                IMethodBinding methodBinding = expressionMethodReference.resolveMethodBinding();
                if (methodBinding != null) {
                    ITypeBinding returnType = concreteServiceType(methodBinding.getReturnType());
                    if (returnType != null) {
                        return returnType;
                    }
                }
            }

            if (expression instanceof TypeMethodReference typeMethodReference) {
                IMethodBinding methodBinding = typeMethodReference.resolveMethodBinding();
                if (methodBinding != null) {
                    ITypeBinding returnType = concreteServiceType(methodBinding.getReturnType());
                    if (returnType != null) {
                        return returnType;
                    }
                }
            }

            return concreteServiceType(expression.resolveTypeBinding());
        }

        private ITypeBinding resolveRegisteredServiceTypeFromVariable(IBinding binding) {
            if (!(binding instanceof IVariableBinding variableBinding)) {
                return null;
            }

            ITypeBinding directType = concreteServiceType(variableBinding.getType());
            if (directType != null) {
                return directType;
            }

            ASTNode declaringNode = root.findDeclaringNode(variableBinding.getVariableDeclaration());
            if (declaringNode instanceof VariableDeclarationFragment variableDeclaration) {
                return resolveRegisteredServiceType(variableDeclaration.getInitializer());
            }
            if (declaringNode instanceof SingleVariableDeclaration variableDeclaration) {
                return resolveRegisteredServiceType(variableDeclaration.getInitializer());
            }

            return null;
        }

        private ITypeBinding concreteServiceType(ITypeBinding typeBinding) {
            ITypeBinding normalized = normalizeTypeBinding(typeBinding);
            if (normalized == null || normalized.getKey() == null || !isServiceType(normalized)) {
                return null;
            }

            if (normalized.isAnonymous() || normalized.isInterface() || normalized.isTypeVariable()) {
                return null;
            }

            return normalized;
        }

        private String resolveJaxRsHttpMethod(List<?> modifiers) {
            for (Object modifier : modifiers) {
                if (!(modifier instanceof Annotation annotation)) {
                    continue;
                }

                String annotationName = annotationName(annotation);
                String httpMethod = JAX_RS_HTTP_ANNOTATIONS.get(annotationName);
                if (httpMethod != null) {
                    return httpMethod;
                }
            }
            return null;
        }

        private String readPathAnnotation(List<?> modifiers) {
            for (Object modifier : modifiers) {
                if (!(modifier instanceof Annotation annotation)) {
                    continue;
                }

                String annotationName = annotationName(annotation);
                if (!JAX_RS_PATH_ANNOTATIONS.contains(annotationName)) {
                    continue;
                }

                String path = extractAnnotationStringValue(annotation);
                if (path != null) {
                    return path;
                }
            }

            return "";
        }

        private String annotationName(Annotation annotation) {
            ITypeBinding binding = annotation.resolveTypeBinding();
            if (binding != null) {
                String qualifiedName = binding.getQualifiedName();
                if (qualifiedName != null && !qualifiedName.isBlank()) {
                    return qualifiedName;
                }
            }
            return annotation.getTypeName().getFullyQualifiedName();
        }

        private String extractAnnotationStringValue(Annotation annotation) {
            if (annotation instanceof SingleMemberAnnotation singleMemberAnnotation) {
                return evaluateStringExpression(singleMemberAnnotation.getValue());
            }

            if (annotation instanceof NormalAnnotation normalAnnotation) {
                for (Object value : normalAnnotation.values()) {
                    if (!(value instanceof org.eclipse.jdt.core.dom.MemberValuePair memberValuePair)) {
                        continue;
                    }
                    if ("value".equals(memberValuePair.getName().getIdentifier())) {
                        return evaluateStringExpression(memberValuePair.getValue());
                    }
                }
            }

            return null;
        }

        private String resolveHelidonHttpMethod(Expression expression) {
            if (expression == null) {
                return null;
            }

            if (expression instanceof ParenthesizedExpression parenthesizedExpression) {
                return resolveHelidonHttpMethod(parenthesizedExpression.getExpression());
            }

            if (expression instanceof CastExpression castExpression) {
                return resolveHelidonHttpMethod(castExpression.getExpression());
            }

            IVariableBinding variableBinding = null;
            if (expression instanceof QualifiedName qualifiedName) {
                variableBinding = qualifiedName.resolveBinding() instanceof IVariableBinding binding ? binding : null;
            } else if (expression instanceof FieldAccess fieldAccess) {
                variableBinding = fieldAccess.resolveFieldBinding();
            } else if (expression instanceof SimpleName simpleName) {
                variableBinding = simpleName.resolveBinding() instanceof IVariableBinding binding ? binding : null;
            }

            if (variableBinding == null) {
                return null;
            }

            ITypeBinding declaringClass = normalizeTypeBinding(variableBinding.getDeclaringClass());
            if (declaringClass == null || !HELIDON_HTTP_METHOD_TYPES.contains(declaringClass.getQualifiedName())) {
                return null;
            }

            String constantName = variableBinding.getName();
            return ROUTE_METHOD_NAMES.get(constantName.toLowerCase(Locale.ROOT));
        }

        private boolean isStringExpression(Expression expression) {
            if (expression == null) {
                return false;
            }

            if (expression instanceof StringLiteral || expression instanceof TextBlock) {
                return true;
            }

            Object constantValue = expression.resolveConstantExpressionValue();
            if (constantValue instanceof String) {
                return true;
            }

            ITypeBinding typeBinding = expression.resolveTypeBinding();
            return typeBinding != null && "java.lang.String".equals(typeBinding.getQualifiedName());
        }

        private String evaluateStringExpression(Expression expression) {
            if (expression == null) {
                return null;
            }

            if (expression instanceof ParenthesizedExpression parenthesizedExpression) {
                return evaluateStringExpression(parenthesizedExpression.getExpression());
            }

            if (expression instanceof CastExpression castExpression) {
                return evaluateStringExpression(castExpression.getExpression());
            }

            Object constantValue = expression.resolveConstantExpressionValue();
            if (constantValue instanceof String stringValue) {
                return stringValue;
            }

            if (expression instanceof StringLiteral stringLiteral) {
                return stringLiteral.getLiteralValue();
            }

            if (expression instanceof TextBlock textBlock) {
                return textBlock.getLiteralValue();
            }

            if (expression instanceof InfixExpression infixExpression
                    && infixExpression.getOperator() == InfixExpression.Operator.PLUS) {
                String left = evaluateStringExpression(infixExpression.getLeftOperand());
                String right = evaluateStringExpression(infixExpression.getRightOperand());
                if (left == null || right == null) {
                    return null;
                }

                StringBuilder builder = new StringBuilder(left).append(right);
                for (Object operand : infixExpression.extendedOperands()) {
                    if (!(operand instanceof Expression extendedExpression)) {
                        return null;
                    }
                    String value = evaluateStringExpression(extendedExpression);
                    if (value == null) {
                        return null;
                    }
                    builder.append(value);
                }
                return builder.toString();
            }

            IVariableBinding variableBinding = null;
            if (expression instanceof SimpleName simpleName) {
                variableBinding = simpleName.resolveBinding() instanceof IVariableBinding binding ? binding : null;
            } else if (expression instanceof QualifiedName qualifiedName) {
                variableBinding = qualifiedName.resolveBinding() instanceof IVariableBinding binding ? binding : null;
            } else if (expression instanceof FieldAccess fieldAccess) {
                variableBinding = fieldAccess.resolveFieldBinding();
            } else if (expression instanceof SuperFieldAccess superFieldAccess) {
                variableBinding = superFieldAccess.resolveFieldBinding();
            }

            if (variableBinding != null) {
                Object variableConstantValue = variableBinding.getConstantValue();
                if (variableConstantValue instanceof String stringValue) {
                    return stringValue;
                }

                ASTNode declaringNode = root.findDeclaringNode(variableBinding.getVariableDeclaration());
                if (declaringNode instanceof VariableDeclarationFragment variableDeclaration) {
                    return evaluateStringExpression(variableDeclaration.getInitializer());
                }
                if (declaringNode instanceof SingleVariableDeclaration variableDeclaration) {
                    return evaluateStringExpression(variableDeclaration.getInitializer());
                }
            }

            return null;
        }

        @SuppressWarnings("unchecked")
        private List<Expression> expressionArguments(MethodInvocation node) {
            return (List<Expression>) node.arguments();
        }
    }
}
